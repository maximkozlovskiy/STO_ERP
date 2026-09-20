import { Processor, OnWorkerEvent } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { BankTransactionSource } from '@prisma/client';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { runWithTenant } from '../../common/tenant/tenant-context';
import { DeadLetterWorkerHost } from '../dead-letter/dead-letter-worker-host';
import { DeadLetterService } from '../dead-letter/dead-letter.service';
import { ProviderConfigService } from '../payments/provider-config.service';
import { IntegrationLogService } from '../integration-logs/integration-log.service';
import { BankProviderRegistry } from './providers/bank-provider-registry';
import { BankReconciliationService } from './bank-reconciliation.service';
import type { RawTx } from './bank-reconciliation.service';

export interface BankStatementPullJob {
  orgId: string;
}

/**
 * Код банк-провайдера → BankTransactionSource для applyImport/IntegrationLog. Невідомий код
 * (legacy / не-API) → FILE_IMPORT (безпечний дефолт). Розширюється при додаванні провайдерів.
 */
function providerToSource(code: string): BankTransactionSource {
  const map: Record<string, BankTransactionSource> = {
    privat24: BankTransactionSource.PRIVAT24_API,
    monobank: BankTransactionSource.MONOBANK_API,
  };
  return map[code] ?? BankTransactionSource.FILE_IMPORT;
}

// MANUAL-VERIFY (константи вікна дат):
// BACKFILL — скільки днів назад тягнути при першому pull (lastPulledAt=null).
const BACKFILL_DAYS = 30;
// MAX_WINDOW — жорстка стеля вікна (навіть якщо lastPulledAt дуже старий) — захист від
// перевантаження API одним велетенським запитом.
const MAX_WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Процесор auto-pull банк-виписки (Privat24). Для кожного banking-рахунку з autoPullEnabled=true:
 * резолвить активний BANK-провайдер per-branch → fetchStatements за вікном дат (lastPulledAt-курсор)
 * → applyImport(source='PRIVAT24_API', skipDuplicates ідемпотентність) → авто-матч confidence===1 →
 * оновлює lastPulledAt. Гроші вже у staging (BankTransaction UNMATCHED) навіть якщо матч упав —
 * авто-матч у try/catch (log-and-continue).
 *
 * Offline-first: pull ТІЛЬКИ через чергу (цей процесор), НІКОЛИ прямий виклик у request-шляху.
 * Tenant: runWithTenant({orgId}) навколо всієї обробки.
 */
@Injectable()
@Processor('bank-statement-polling', { concurrency: 2 })
export class BankStatementPullProcessor extends DeadLetterWorkerHost {
  private readonly logger = new Logger(BankStatementPullProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providerConfig: ProviderConfigService,
    private readonly registry: BankProviderRegistry,
    private readonly reconciliation: BankReconciliationService,
    private readonly integrationLog: IntegrationLogService,
    deadLetter: DeadLetterService,
  ) {
    super(deadLetter);
  }

  async process(job: Job<BankStatementPullJob>): Promise<void> {
    return runWithTenant({ orgId: job.data.orgId }, async () => {
      const { orgId } = job.data;

      const accounts = await this.prisma.bankAccount.findMany({
        where: { orgId, deletedAt: null, autoPullEnabled: true },
        select: {
          id: true,
          ibanUA: true,
          branchId: true,
          lastPulledAt: true,
          currencyId: true,
          provider: true,
        },
      });
      if (accounts.length === 0) return;

      const to = new Date();
      const minFrom = new Date(to.getTime() - MAX_WINDOW_DAYS * DAY_MS);

      for (const acc of accounts) {
        // Multi-bank: якщо рахунок привʼязаний до провайдера (BankAccount.provider) → резолвимо саме
        // його (resolveByCode); інакше legacy-fallback на активний per-branch BANK-провайдер.
        const active = acc.provider
          ? await this.providerConfig.resolveByCode(orgId, acc.branchId, 'BANK', acc.provider)
          : await this.providerConfig.resolveActive(orgId, acc.branchId, 'BANK');
        if (!active) {
          this.logger.debug(`Рахунок ${acc.id}: BANK-провайдер не налаштовано — пропуск`);
          continue;
        }
        const provider = this.registry.get(active.provider);
        if (!provider) continue; // невідомий код — registry вже залогував

        // Вікно дат: від lastPulledAt (курсор) або backfill; але не старіше MAX_WINDOW (стеля).
        const backfillFrom = new Date(to.getTime() - BACKFILL_DAYS * DAY_MS);
        const cursorFrom = acc.lastPulledAt ?? backfillFrom;
        const from = cursorFrom.getTime() < minFrom.getTime() ? minFrom : cursorFrom;

        let rows: RawTx[];
        try {
          rows = await this.integrationLog.wrap(
            {
              orgId,
              branchId: acc.branchId,
              provider: active.provider,
              operation: 'fetchStatements',
              documentType: 'BankAccount',
              documentId: acc.id,
            },
            () =>
              provider.fetchStatements(
                { apiUrl: active.apiUrl, credentials: active.credentials },
                { iban: acc.ibanUA, from, to },
              ),
          );
        } catch (e) {
          // Помилка мережі/API одного рахунку не має валити pull інших рахунків орг.
          this.logger.error(
            `Рахунок ${acc.id}: fetchStatements впав — ${e instanceof Error ? e.message : e}`,
          );
          continue;
        }

        if (rows.length === 0) {
          // Немає нових транзакцій — все одно рухаємо курсор (порожнє вікно оброблено).
          // Best-effort: збій курсора одного рахунку не валить решту (Bug #768 isolation).
          try {
            await this.updateCursor(orgId, acc.id, to);
          } catch (e) {
            this.logger.error(
              `Рахунок ${acc.id}: оновлення курсора (порожнє вікно) впало: ${e instanceof Error ? e.message : e}`,
            );
          }
          continue;
        }

        // Bug #768: per-account isolation мусить охоплювати ВЕСЬ хвіст обробки рахунку, не лише
        // fetch. Помилка applyImport (транзієнтний збій БД / lock-timeout / resolveBaseConversion)
        // одного рахунку НЕ має валити pull інших рахунків орг (інакше один битий рахунок голодує
        // решту вікна). На помилку imp/match — log-and-continue; курсор НЕ рухаємо (даних не втрачаємо,
        // наступний pull повторить вікно ідемпотентно через skipDuplicates).
        try {
          // Ідемпотентний імпорт у staging (skipDuplicates по unique externalId). RawTx.operationDate
          // (Date) → ISO-рядок для ApplyRowDto (applyImport робить new Date(...) назад).
          await this.reconciliation.applyImport(
            orgId,
            {
              bankAccountId: acc.id,
              rows: rows.map(r => ({
                externalId: r.externalId,
                operationDate: r.operationDate.toISOString(),
                amount: r.amount,
                payerName: r.payerName ?? undefined,
                payerIban: r.payerIban ?? undefined,
                payerEdrpou: r.payerEdrpou ?? undefined,
                purpose: r.purpose ?? undefined,
                rawData: r.rawData,
              })),
            },
            providerToSource(active.provider),
          );
        } catch (e) {
          this.logger.error(
            `Рахунок ${acc.id}: applyImport впав — курсор не рухаю, наступний pull повторить: ${e instanceof Error ? e.message : e}`,
          );
          continue; // НЕ оновлюємо курсор → жодної втрати транзакцій вікна
        }

        // АВТО-МАТЧ (лише confidence===1 — упевнений збіг за IBAN). Гроші вже у staging; помилка
        // матчу окремого рядка не має зривати pull — log-and-continue.
        try {
          const matches = await this.reconciliation.resolveBatch(orgId, rows);
          for (const row of rows) {
            const m = matches.get(row.externalId);
            if (!m || m.status !== 'matched' || m.confidence !== 1 || !m.counterpartyId) continue;
            const tx = await this.prisma.bankTransaction.findFirst({
              where: {
                orgId,
                bankAccountId: acc.id,
                externalId: row.externalId,
                status: 'UNMATCHED',
                deletedAt: null,
              },
              select: { id: true },
            });
            if (!tx) continue; // вже рознесено / дубль
            try {
              await this.reconciliation.matchTransaction(orgId, tx.id, {
                counterpartyId: m.counterpartyId,
                type: m.matchType ?? 'SERVICE',
                invoiceId: m.invoiceId,
              });
            } catch (e) {
              this.logger.warn(
                `Авто-матч транзакції ${tx.id} не вдався — лишаю у staging: ${e instanceof Error ? e.message : e}`,
              );
            }
          }
        } catch (e) {
          this.logger.error(
            `Авто-матч батчу рахунку ${acc.id} впав: ${e instanceof Error ? e.message : e}`,
          );
        }

        // Курсор рухаємо лише коли imp пройшов. Помилка cursor-update одного рахунку теж не має
        // валити решту (best-effort — наступний pull повторить вікно ідемпотентно).
        try {
          await this.updateCursor(orgId, acc.id, to);
        } catch (e) {
          this.logger.error(
            `Рахунок ${acc.id}: оновлення курсора lastPulledAt впало: ${e instanceof Error ? e.message : e}`,
          );
        }
      }
    });
  }

  /** Оновити курсор lastPulledAt (tenant-guarded updateMany). */
  private async updateCursor(orgId: string, accountId: string, to: Date): Promise<void> {
    await this.prisma.bankAccount.updateMany({
      where: { id: accountId, orgId, deletedAt: null },
      data: { lastPulledAt: to },
    });
  }

  // Централізований DLQ: терминальний провал → DeadLetterJob.
  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): Promise<void> {
    return this.deadLetterOnFailed(job, err);
  }
}
