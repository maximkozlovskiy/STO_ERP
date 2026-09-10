import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { runWithTenant } from '../../common/tenant/tenant-context';
import { FiscalUnauthorizedError } from './fiscal/fiscal-provider.interface';
import { ProviderConfigService } from './provider-config.service';
import { CashShiftService } from './cash-shift.service';
import { IntegrationLogService } from '../integration-logs/integration-log.service';

interface FiscalReceiptJob {
  paymentId: string;
  orgId: string;
  branchId: string | null;
  amount: number;
  method: string;
}

// concurrency: 3 — кожен job = 15s мережевий виклик Checkbox. concurrency обмежує паралелізм
// (rate-limit ліцензії) + дренить чергу ~3× швидше. AbortController-timeout у CheckboxClient.
@Injectable()
@Processor('checkbox', { concurrency: 3 })
export class CheckboxProcessor extends WorkerHost {
  private readonly logger = new Logger(CheckboxProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providerConfig: ProviderConfigService,
    private readonly shifts: CashShiftService,
    private readonly integrationLog: IntegrationLogService,
  ) {
    super();
  }

  async process(job: Job<FiscalReceiptJob>): Promise<void> {
    return runWithTenant({ orgId: job.data.orgId }, async () => {
      const { paymentId, orgId, branchId, amount, method } = job.data;

      // Idempotency: якщо fiscalReceiptId уже є (попередня спроба пробила чек, але DB-update впав),
      // пропускаємо зовнішній виклик — інакше retry створить ДРУГИЙ чек у Checkbox.
      const existingPayment = await this.prisma.payment.findFirst({
        where: { id: paymentId, orgId },
        select: { fiscalReceiptId: true },
      });
      if (!existingPayment) return; // видалено / cross-tenant — дропаємо
      if (existingPayment.fiscalReceiptId) {
        this.logger.debug(`Фіскальний чек вже існує для платежу ${paymentId}, пропускаємо`);
        return;
      }

      // Активний ПРРО-провайдер філії (config + legacy-fallback). null → ПРРО не налаштовано.
      const active = await this.providerConfig.resolveActive(orgId, branchId, 'FISCAL');
      if (!active) {
        // ПРРО вимкнено на філії → SKIPPED (не лишаємо QUEUED навічно). Не throw — це конфіг-стан.
        this.logger.debug(`ПРРО не налаштовано для org=${orgId}, пропускаємо (SKIPPED)`);
        await this.prisma.payment
          .update({ where: { id: paymentId, orgId }, data: { fiscalStatus: 'SKIPPED' } })
          .catch(() => undefined);
        return;
      }

      // Резолвимо branchId для пошуку зміни (без нього шукаємо будь-яку OPEN зміну org — але
      // зазвичай branchId є з payment.workOrder.branchId).
      const effectiveBranchId = branchId ?? undefined;

      // Знайти відкриту зміну; якщо немає — за режимом.
      let shift = effectiveBranchId
        ? await this.shifts.findOpenShift(orgId, effectiveBranchId)
        : null;
      if (!shift) {
        if (active.shiftMode === 'AUTO_OPEN' && effectiveBranchId) {
          // Авто-режим: пробуємо відкрити зміну (sign-in+open). Помилка → throw → BullMQ retry.
          const opened = await this.shifts.open(orgId, effectiveBranchId).catch((e: unknown) => {
            throw new Error(
              `Авто-відкриття зміни не вдалось: ${e instanceof Error ? e.message : e}`,
            );
          });
          shift = { id: opened.id, checkboxShiftId: opened.checkboxShiftId };
        } else {
          // MANUAL без відкритої зміни: чек ЧЕКАЄ (лишаємо QUEUED). throw → retry дренить коли
          // касир відкриє зміну. Не FAILED-terminal (це не помилка, а очікування).
          throw new Error('Немає відкритої каси-зміни — чек чекає відкриття');
        }
      }

      // Гарантуємо валідний cashier-token (refresh на expiry) + резолвлений провайдер зміни.
      let { provider, cfg, token } = await this.shifts.ensureToken(orgId, shift.id);

      // Пробити чек; 401 → одноразовий re-sign-in → повтор. Кожен sellReceipt = окремий обмін
      // (2 рядки логу при 401-retry — навмисно, це 2 реальні мережеві виклики).
      const sellCtx = {
        orgId,
        branchId,
        operation: 'sellReceipt',
        documentType: 'Payment',
        documentId: paymentId,
      };
      let result;
      try {
        result = await this.integrationLog.wrap({ ...sellCtx, provider: provider.code }, () =>
          provider.sellReceipt(cfg, token, { amount, method }),
        );
      } catch (e) {
        if (e instanceof FiscalUnauthorizedError) {
          ({ provider, cfg, token } = await this.shifts.refreshToken(orgId, shift.id));
          result = await this.integrationLog.wrap({ ...sellCtx, provider: provider.code }, () =>
            provider.sellReceipt(cfg, token, { amount, method }),
          );
        } else {
          throw e;
        }
      }

      // Bug #713 — атомарний CAS-write (fiscalReceiptId:null у where). Pre-read (рядок 39) — STALE:
      // якби два job на той самий paymentId колись співіснували (concurrency=3), обидва пройшли б
      // guard і пробили б чек, і обидва зробили б plain update — БД зберегла б ID другого чека,
      // приховавши дубль. `updateMany where fiscalReceiptId:null` → рівно перший запис виграє; program
      // на count===0 не перезатирає вже-збережений чек (принаймні БД лишається консистентною до
      // ПЕРШОГО чека). Retry-endpoint (fiscalStatus==='FAILED' + fiscalReceiptId===null) робить
      // подвійний enqueue практично неможливим — це backstop проти майбутнього рефактора.
      const wrote = await this.prisma.payment.updateMany({
        where: { id: paymentId, orgId, fiscalReceiptId: null },
        data: { fiscalReceiptId: result.fiscalReceiptId, fiscalStatus: 'DONE', fiscalError: null },
      });
      if (wrote.count === 0) {
        this.logger.warn(
          `Фіскальний чек для платежу ${paymentId} вже записаний паралельно — ${result.fiscalReceiptId} відкинуто (можливий дубль у Checkbox, потрібен розбір)`,
        );
        return;
      }
      this.logger.log(`Фіскальний чек ${result.fiscalReceiptId} для платежу ${paymentId}`);
    });
  }

  /**
   * Пише FAILED лише коли вичерпано ВСІ спроби (attemptsMade сягнув opts.attempts). На проміжних
   * провалах (у т.ч. «чекає зміни» у manual) статус лишається QUEUED — не «мигає» FAILED.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<FiscalReceiptJob>, err: Error): Promise<void> {
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return; // ще будуть ретраї
    const { paymentId, orgId } = job.data;
    await this.prisma.payment
      .update({
        where: { id: paymentId, orgId },
        data: { fiscalStatus: 'FAILED', fiscalError: err?.message?.slice(0, 500) ?? 'Помилка' },
      })
      .catch((e: unknown) =>
        this.logger.error(
          `Не вдалось записати FAILED для платежу ${paymentId}: ${e instanceof Error ? e.message : e}`,
        ),
      );
  }
}
