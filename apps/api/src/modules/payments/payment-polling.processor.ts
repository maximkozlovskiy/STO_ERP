import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MonobankClient } from './monobank.client';
import { PaymentsService } from './payments.service';

interface PollJob {
  intentId: string;
  orgId: string;
}

const POLL_INTERVAL_MS = 5_000;

/**
 * Опитує статус онлайн-наміру у gateway. Self-re-enqueue: поки pending — ставить себе знову з
 * delay; success → CAS (PENDING→PAID) → payments.create РІВНО один раз; failure/expired/timeout →
 * термінальний статус, стоп. Idempotency через CAS-guard (where status:PENDING) — конкурентні
 * poll-и не подвоюють Payment.
 */
@Injectable()
@Processor('payment-polling', { concurrency: 3 })
export class PaymentPollingProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentPollingProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly monobank: MonobankClient,
    private readonly payments: PaymentsService,
    @InjectQueue('payment-polling') private readonly pollQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<PollJob>): Promise<void> {
    const { intentId, orgId } = job.data;

    const intent = await this.prisma.onlinePaymentIntent.findFirst({
      where: { id: intentId, orgId, deletedAt: null },
      select: {
        status: true,
        gatewayInvoiceId: true,
        expiresAt: true,
        counterpartyId: true,
        invoiceId: true,
        amount: true,
        workOrderId: true,
      },
    });
    if (!intent) return; // видалено — стоп
    if (intent.status !== 'PENDING') return; // уже термінальний — стоп
    if (!intent.gatewayInvoiceId) return; // немає gateway-рахунку — нема що опитувати

    // Жорсткий wall-clock таймаут → EXPIRED (не опитуємо вічно).
    if (intent.expiresAt && intent.expiresAt.getTime() < Date.now()) {
      await this.transition(intentId, orgId, 'EXPIRED', 'Час на оплату вичерпано');
      return;
    }

    const bs = await this.prisma.branchSettings.findFirst({
      where: intent.workOrderId
        ? {
            orgId,
            branchId: (
              await this.prisma.workOrder.findFirst({
                where: { id: intent.workOrderId, orgId },
                select: { branchId: true },
              })
            )?.branchId,
          }
        : { orgId },
      select: { monobankToken: true, monobankApiUrl: true },
    });
    if (!bs?.monobankToken) {
      await this.transition(intentId, orgId, 'FAILED', 'monobank токен зник');
      return;
    }

    const { status } = await this.monobank.getStatus(
      bs.monobankApiUrl,
      bs.monobankToken,
      intent.gatewayInvoiceId,
    );

    if (status === 'paid') {
      // CAS PENDING→PAID: рівно один poll виграє → створює Payment. Конкурентні → count=0 → стоп.
      const won = await this.prisma.onlinePaymentIntent.updateMany({
        where: { id: intentId, orgId, status: 'PENDING' },
        data: { status: 'PAID' },
      });
      if (won.count === 0) return; // інший poll уже провів
      try {
        const payment = await this.payments.create(orgId, {
          counterpartyId: intent.counterpartyId,
          invoiceId: intent.invoiceId ?? undefined,
          amount: Number(intent.amount),
          method: 'monobank_qr',
        });
        await this.prisma.onlinePaymentIntent.update({
          where: { id: intentId },
          data: { paymentId: payment.id },
        });
        this.logger.log(`Онлайн-оплата ${intentId} → Payment ${payment.id}`);
      } catch (e) {
        // Payment не створився після PAID-переходу — лишаємо PAID+error (гроші у gateway є;
        // касир розрулює вручну). НЕ відкочуємо PAID, щоб retry не подвоїв.
        await this.prisma.onlinePaymentIntent
          .update({
            where: { id: intentId },
            data: {
              error: `Payment не створено: ${e instanceof Error ? e.message.slice(0, 400) : e}`,
            },
          })
          .catch(() => undefined);
        this.logger.error(`Онлайн-оплата ${intentId}: PAID, але Payment не створено`);
      }
      return;
    }

    if (status === 'failed') {
      await this.transition(intentId, orgId, 'FAILED', 'Оплату відхилено');
      return;
    }
    if (status === 'expired') {
      await this.transition(intentId, orgId, 'EXPIRED', 'Час на оплату вичерпано');
      return;
    }

    // pending → опитати знову.
    await this.pollQueue.add(
      'poll',
      { intentId, orgId },
      {
        delay: POLL_INTERVAL_MS,
        jobId: `payment-poll-${intentId}`,
        removeOnComplete: true,
        removeOnFail: 200,
      },
    );
  }

  /** CAS-перехід у термінальний статус (лише з PENDING). */
  private async transition(
    intentId: string,
    orgId: string,
    status: 'FAILED' | 'EXPIRED',
    error: string,
  ): Promise<void> {
    await this.prisma.onlinePaymentIntent
      .updateMany({ where: { id: intentId, orgId, status: 'PENDING' }, data: { status, error } })
      .catch(() => undefined);
  }
}
