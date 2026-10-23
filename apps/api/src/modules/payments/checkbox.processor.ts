import { Processor, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { runWithTenant } from '../../common/tenant/tenant-context';
import { FiscalUnauthorizedError } from './fiscal/fiscal-provider.interface';
import { ProviderConfigService } from './provider-config.service';
import { CashShiftService } from './cash-shift.service';
import { IntegrationLogService } from '../integration-logs/integration-log.service';
import { DeadLetterWorkerHost } from '../../modules/dead-letter/dead-letter-worker-host';
import { DeadLetterService } from '../../modules/dead-letter/dead-letter.service';

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
export class CheckboxProcessor extends DeadLetterWorkerHost {
  private readonly logger = new Logger(CheckboxProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providerConfig: ProviderConfigService,
    private readonly shifts: CashShiftService,
    private readonly integrationLog: IntegrationLogService,
    deadLetter: DeadLetterService,
  ) {
    super(deadLetter);
  }

  async process(job: Job<FiscalReceiptJob>): Promise<void> {
    return runWithTenant({ orgId: job.data.orgId }, async () => {
      const { paymentId, orgId, branchId, amount, method } = job.data;

      // Idempotency: якщо fiscalReceiptId уже є (попередня спроба пробила чек, але DB-update впав),
      // пропускаємо зовнішній виклик — інакше retry створить ДРУГИЙ чек у Checkbox.
      const existingPayment = await this.prisma.payment.findFirst({
        where: { id: paymentId, orgId },
        select: {
          fiscalReceiptId: true,
          reversedAt: true,
          cashRegister: { select: { id: true, branchId: true, isFiscal: true, deletedAt: true } },
        },
      });
      if (!existingPayment) return; // видалено / cross-tenant — дропаємо
      if (existingPayment.fiscalReceiptId) {
        this.logger.debug(`Фіскальний чек вже існує для платежу ${paymentId}, пропускаємо`);
        return;
      }
      // Сторновану оплату не фіскалізуємо (BR-CASH-024): сторно вже зняло її з черги (SKIPPED),
      // а job, поставлений раніше, тут просто закінчується без чека.
      if (existingPayment.reversedAt) {
        this.logger.debug(`Платіж ${paymentId} сторновано — чек не пробиваємо`);
        return;
      }

      // Зміна — своя в кожної фіскальної каси (BR-CASH-027): готівкова оплата знає свою касу, тож
      // чек іде в зміну САМЕ цієї каси, а філія — та, де каса стоїть (наряд може бути іншої філії,
      // оплата без наряду філії в job не має). Оплата без каси (картка, QR) чи через нефіскальну
      // касу своєї зміни не має — для неї лишається будь-яка OPEN-зміна філії наряду, як раніше.
      const reg = existingPayment.cashRegister;
      const fiscalRegister = reg && reg.isFiscal && !reg.deletedAt ? reg : null;
      const effectiveBranchId = fiscalRegister?.branchId ?? branchId ?? undefined;
      const cashRegisterId = fiscalRegister?.id;

      // Активний ПРРО-провайдер філії (config + legacy-fallback). null → ПРРО не налаштовано.
      const active = await this.providerConfig.resolveActive(
        orgId,
        effectiveBranchId ?? null,
        'FISCAL',
      );
      if (!active) {
        // ПРРО вимкнено на філії → SKIPPED (не лишаємо QUEUED навічно). Не throw — це конфіг-стан.
        this.logger.debug(`ПРРО не налаштовано для org=${orgId}, пропускаємо (SKIPPED)`);
        await this.prisma.payment
          .update({ where: { id: paymentId, orgId }, data: { fiscalStatus: 'SKIPPED' } })
          .catch(() => undefined);
        return;
      }

      // Знайти відкриту зміну; якщо немає — за режимом.
      let shift = effectiveBranchId
        ? await this.shifts.findOpenShift(orgId, effectiveBranchId, cashRegisterId)
        : null;
      if (!shift) {
        if (active.shiftMode === 'AUTO_OPEN' && effectiveBranchId) {
          // Авто-режим: пробуємо відкрити зміну (sign-in+open) — на касі оплати, а без неї
          // найстарішу касу філії. Помилка → throw → BullMQ retry.
          const opened = await this.shifts
            .open(orgId, effectiveBranchId, undefined, cashRegisterId)
            .catch((e: unknown) => {
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
        branchId: effectiveBranchId ?? null,
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
    // Централізований DLQ: фіскальний термінальний провал ТАКОЖ лягає у DeadLetterJob (аудит
    // стеку, backend #2). deadLetterOnFailed повторно перевіряє терминальний guard — безпечно.
    await this.deadLetterOnFailed(job, err);
  }
}
