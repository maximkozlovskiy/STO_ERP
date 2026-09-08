import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PaymentGatewayRegistry } from './gateways/payment-gateway-registry';
import { ProviderConfigService } from './provider-config.service';
import { PaymentsService } from './payments.service';
import { IntegrationLogService } from '../integration-logs/integration-log.service';

interface PollJob {
  intentId: string;
  orgId: string;
  // Лічильник спроб реконсиляції (PAID але Payment не створився). Обмежує ретраї, щоб
  // ПОСТІЙНА помилка create (напр. рахунок переплачено паралельно) не крутилась вічно 5с-циклом.
  finalizeAttempts?: number;
  // F2: лічильник pending-опитувань. Захист для наміру БЕЗ expiresAt (wall-clock guard не спрацює):
  // шлюз, що ніколи не відповідає paid/failed/expired, інакше опитувався б вічно кожні 5с.
  pollAttempts?: number;
}

const POLL_INTERVAL_MS = 5_000;
// Стеля спроб довести Payment до створення після PAID. ~ MAX × POLL_INTERVAL = ~30 хв опитувань.
// Далі лишаємо PAID+error для ручного розбору касиром (гроші у gateway є, Payment треба вручну).
const MAX_FINALIZE_ATTEMPTS = 360;
// F2: стеля pending-опитувань (~ MAX × POLL_INTERVAL = ~2 год). Стеля-запобіжник ЛИШЕ для наміру
// без expiresAt (з expiresAt його раніше закриє wall-clock guard). Далі → EXPIRED, стоп.
const MAX_POLL_ATTEMPTS = 1_440;

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
    private readonly gateways: PaymentGatewayRegistry,
    private readonly providerConfig: ProviderConfigService,
    private readonly payments: PaymentsService,
    @InjectQueue('payment-polling') private readonly pollQueue: Queue,
    private readonly integrationLog: IntegrationLogService,
  ) {
    super();
  }

  async process(job: Job<PollJob>): Promise<void> {
    const { intentId, orgId, finalizeAttempts = 0, pollAttempts = 0 } = job.data;

    const intent = await this.prisma.onlinePaymentIntent.findFirst({
      where: { id: intentId, orgId, deletedAt: null },
      select: {
        status: true,
        gateway: true,
        gatewayInvoiceId: true,
        expiresAt: true,
        counterpartyId: true,
        invoiceId: true,
        amount: true,
        workOrderId: true,
        paymentId: true,
      },
    });
    if (!intent) return; // видалено — стоп

    // РЕКОНСИЛЯЦІЯ (MONEY-CRITICAL): якщо намір уже PAID, але Payment так і не створено
    // (paymentId=null) — це «вікно збою»: CAS PENDING→PAID закомітився, а потім процес упав
    // ДО payments.create (або create кинув і ми лишили PAID+error). Гроші у monobank є, а
    // Payment/settlement — ні. Без цього блоку наступний poll робив би early-return на
    // `status !== PENDING` і Payment не створився б НІКОЛИ. jobId-дедуп (`payment-poll-<id>`)
    // гарантує single-flight на намір → повторний create того ж наміру не подвоїться.
    if (intent.status === 'PAID') {
      if (intent.paymentId) return; // Payment уже є — намір повністю завершено, стоп
      await this.finalizePayment(intentId, orgId, intent, finalizeAttempts, /* reconcile */ true);
      return;
    }
    if (intent.status !== 'PENDING') return; // FAILED/EXPIRED — термінальний, стоп
    if (!intent.gatewayInvoiceId) return; // немає gateway-рахунку — нема що опитувати

    // Жорсткий wall-clock таймаут → EXPIRED (не опитуємо вічно).
    if (intent.expiresAt && intent.expiresAt.getTime() < Date.now()) {
      await this.transition(intentId, orgId, 'EXPIRED', 'Час на оплату вичерпано');
      return;
    }
    // F2: запобіжник для наміру БЕЗ expiresAt — wall-clock guard вище його б не закрив, тож
    // шлюз що ніколи не резолвиться крутив би 5с-цикл вічно. Стеля опитувань → EXPIRED.
    if (pollAttempts >= MAX_POLL_ATTEMPTS) {
      await this.transition(
        intentId,
        orgId,
        'EXPIRED',
        'Час на оплату вичерпано (стеля опитувань)',
      );
      return;
    }

    // Резолвимо конкретний шлюз наміру (intent.gateway) + його креди per-branch (legacy-fallback).
    const branchId = intent.workOrderId
      ? (
          await this.prisma.workOrder.findFirst({
            where: { id: intent.workOrderId, orgId },
            select: { branchId: true },
          })
        )?.branchId
      : undefined;
    const cfg = await this.providerConfig.resolveByCode(orgId, branchId, 'PAYMENT', intent.gateway);
    const gateway = this.gateways.get(intent.gateway);
    if (!cfg || !gateway) {
      await this.transition(intentId, orgId, 'FAILED', 'Платіжний шлюз більше не налаштовано');
      return;
    }

    const { status } = await this.integrationLog.wrap(
      {
        orgId,
        branchId,
        provider: intent.gateway,
        operation: 'getStatus',
        documentType: 'OnlinePaymentIntent',
        documentId: intentId,
      },
      () =>
        gateway.getStatus(
          { apiUrl: cfg.apiUrl, credentials: cfg.credentials },
          intent.gatewayInvoiceId!,
        ),
    );

    if (status === 'paid') {
      // CAS PENDING→PAID: рівно один poll виграє → створює Payment. Конкурентні → count=0 → стоп.
      const won = await this.prisma.onlinePaymentIntent.updateMany({
        where: { id: intentId, orgId, status: 'PENDING' },
        data: { status: 'PAID' },
      });
      if (won.count === 0) return; // інший poll уже провів
      await this.finalizePayment(intentId, orgId, intent, finalizeAttempts, /* reconcile */ false);
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

    // pending → опитати знову (з інкрементом лічильника опитувань для F2-стелі).
    await this.pollQueue.add(
      'poll',
      { intentId, orgId, pollAttempts: pollAttempts + 1 },
      {
        delay: POLL_INTERVAL_MS,
        jobId: `payment-poll-${intentId}`,
        removeOnComplete: true,
        removeOnFail: 200,
      },
    );
  }

  /**
   * Створює Payment для наміру, що вже переведений у PAID, і лінкує paymentId (idempotency).
   * Виклик безпечний під single-flight (jobId-дедуп на намір): у будь-який момент активний
   * лише один poll-job на intentId, тож повторний create того ж наміру не подвоїться.
   *
   * На помилці create (напр. invoice-overpay CAS відхилив, Redis/DB тимчасово недоступні) ми
   * лишаємо PAID+error і ПЕРЕ-СТАВЛЯЄМО poll у чергу, щоб довести Payment до створення — гроші
   * у gateway реальні, не можна лишати намір без Payment/settlement назавжди. jobId-дедуп
   * (`payment-poll-<id>`) утримує рівно один job на намір, тож re-enqueue не створює лавину.
   * @param reconcile лише для логів (true — відновлення після «вікна збою»).
   */
  private async finalizePayment(
    intentId: string,
    orgId: string,
    intent: {
      gateway: string;
      counterpartyId: string;
      invoiceId: string | null;
      amount: import('@prisma/client').Prisma.Decimal | number;
    },
    finalizeAttempts: number,
    reconcile: boolean,
  ): Promise<void> {
    try {
      // Idempotency (Bug #688): якщо попередній finalize створив Payment, але link-write
      // (paymentId) упав, у БД уже є Payment із цим onlinePaymentIntentId. Не можна створювати
      // другий (double-charge). Спершу шукаємо наявний по унікальному лінку — якщо є, лише
      // до-лінковуємо paymentId (recovery «вікна збою» без дубля).
      const existing = await this.prisma.payment.findFirst({
        where: { orgId, onlinePaymentIntentId: intentId },
        select: { id: true },
      });
      const payment =
        existing ??
        (await this.payments.create(orgId, {
          counterpartyId: intent.counterpartyId,
          invoiceId: intent.invoiceId ?? undefined,
          amount: Number(intent.amount),
          // Спосіб оплати = <шлюз>_qr (monobank_qr / liqpay_qr) — узгоджено з PaymentMethodConfig.
          method: `${intent.gateway}_qr`,
          onlinePaymentIntentId: intentId,
        }));
      await this.prisma.onlinePaymentIntent.update({
        where: { id: intentId },
        data: { paymentId: payment.id, error: null },
      });
      this.logger.log(
        `Онлайн-оплата ${intentId} → Payment ${payment.id}${
          reconcile ? ' (реконсиляція)' : ''
        }${existing ? ' (idempotent-relink)' : ''}`,
      );
    } catch (e) {
      // P2002 на onlinePaymentIntentId → інший потік/попередня спроба вже створила Payment для
      // цього наміру (гонка або повтор). Дістаємо наявний і лінкуємо — це успіх, не помилка.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const dup = await this.prisma.payment
          .findFirst({
            where: { orgId, onlinePaymentIntentId: intentId },
            select: { id: true },
          })
          .catch(() => null);
        if (dup) {
          await this.prisma.onlinePaymentIntent
            .update({ where: { id: intentId }, data: { paymentId: dup.id, error: null } })
            .catch(() => undefined);
          this.logger.log(`Онлайн-оплата ${intentId} → Payment ${dup.id} (dedup P2002-relink)`);
          return;
        }
      }
      // Payment не створився після PAID-переходу — лишаємо PAID+error (гроші у gateway є).
      // НЕ відкочуємо PAID, щоб retry не подвоїв. Записуємо причину для касира/оператора.
      await this.prisma.onlinePaymentIntent
        .update({
          where: { id: intentId },
          data: {
            error: `Payment не створено: ${e instanceof Error ? e.message.slice(0, 400) : e}`,
          },
        })
        .catch(() => undefined);
      // Продовжуємо ретраїти, поки Payment не буде створено (наступний poll піде гілкою
      // реконсиляції PAID+paymentId=null). jobId-дедуп → рівно один job на намір, не лавина.
      // Але з СТЕЛЕЮ: постійна помилка create (рахунок переплачено паралельно тощо) не має
      // крутитись вічно — після MAX лишаємо PAID+error для ручного розбору касиром.
      const next = finalizeAttempts + 1;
      if (next > MAX_FINALIZE_ATTEMPTS) {
        this.logger.error(
          `Онлайн-оплата ${intentId}: PAID, Payment не створено за ${MAX_FINALIZE_ATTEMPTS} спроб — потрібен ручний розбір`,
        );
        return;
      }
      this.logger.error(
        `Онлайн-оплата ${intentId}: PAID, але Payment не створено (спроба ${next}/${MAX_FINALIZE_ATTEMPTS})`,
      );
      await this.pollQueue
        .add(
          'poll',
          { intentId, orgId, finalizeAttempts: next },
          {
            delay: POLL_INTERVAL_MS,
            jobId: `payment-poll-${intentId}`,
            removeOnComplete: true,
            removeOnFail: 200,
          },
        )
        .catch(() => undefined);
    }
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
