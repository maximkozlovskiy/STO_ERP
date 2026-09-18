import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import { PrismaService } from '../../prisma/prisma.service';
import { PaymentGatewayRegistry } from './gateways/payment-gateway-registry';
import { ProviderConfigService } from './provider-config.service';
import { IntegrationLogService } from '../integration-logs/integration-log.service';

// Жорсткий wall-clock таймаут наміру (клієнт не оплатив → EXPIRED). 15 хв.
const INTENT_TTL_MS = 15 * 60 * 1000;
// Інтервал опитування статусу gateway.
const POLL_INTERVAL_MS = 5_000;

export interface CreateIntentInput {
  invoiceId: string;
  amount?: number; // якщо не задано — залишок за рахунком
}

export interface OnlineIntentDto {
  id: string;
  status: string; // PENDING/PAID/FAILED/EXPIRED
  pageUrl: string | null;
  amount: number;
  paymentId: string | null;
  error: string | null;
}

/**
 * Онлайн-оплата (QR через monobank). createIntent → gateway invoice/create → QR (pageUrl).
 * Polling-черга опитує статус; на PAID через CAS (PENDING→PAID) створює Payment РІВНО один раз.
 * QR-на-екрані → клієнт платить на сторінці monobank → 0 публічних endpoint (offline-first за NAT).
 */
@Injectable()
export class OnlinePaymentService {
  private readonly logger = new Logger(OnlinePaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateways: PaymentGatewayRegistry,
    private readonly providerConfig: ProviderConfigService,
    @InjectQueue('payment-polling') private readonly pollQueue: Queue,
    private readonly integrationLog: IntegrationLogService,
  ) {}

  /** Створити намір + gateway-рахунок, показати QR. Прив'язка — з рахунка (invoice). */
  async createIntent(orgId: string, input: CreateIntentInput): Promise<OnlineIntentDto> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: input.invoiceId, orgId, deletedAt: null },
      select: {
        counterpartyId: true,
        workOrderId: true,
        amount: true,
        paidAmount: true,
        status: true,
      },
    });
    if (!invoice)
      throw new NotFoundException(translateError('err.onlinePayment.invoiceNotFound', getLocale()));
    if (
      invoice.status !== 'SENT' &&
      invoice.status !== 'PARTIALLY_PAID' &&
      invoice.status !== 'OVERDUE'
    ) {
      throw new BadRequestException(
        translateError('err.onlinePayment.invoiceStatusNoPayment', getLocale(), {
          status: invoice.status,
        }),
      );
    }

    const remaining = Number(invoice.amount) - Number(invoice.paidAmount);
    const amount = input.amount ?? remaining;
    if (amount <= 0)
      throw new BadRequestException(translateError('err.onlinePayment.noRemaining', getLocale()));
    if (amount > remaining + 1e-9) {
      throw new BadRequestException(
        translateError('err.onlinePayment.amountExceedsRemaining', getLocale(), {
          remaining: remaining.toFixed(2),
        }),
      );
    }

    // Активний платіжний шлюз філії (гілка наряду або перша філія org), з legacy-fallback.
    const branchId = invoice.workOrderId
      ? (
          await this.prisma.workOrder.findFirst({
            where: { id: invoice.workOrderId, orgId },
            select: { branchId: true },
          })
        )?.branchId
      : undefined;
    const active = await this.providerConfig.resolveActive(orgId, branchId, 'PAYMENT');
    if (!active) {
      throw new BadRequestException(
        translateError('err.onlinePayment.acquiringNotConfigured', getLocale()),
      );
    }
    const gateway = this.gateways.get(active.provider);
    if (!gateway) {
      throw new BadRequestException(
        translateError('err.onlinePayment.unknownGateway', getLocale(), {
          provider: active.provider,
        }),
      );
    }

    // Створюємо намір ПЕРШИМ (щоб reference був стабільним id), потім gateway-рахунок.
    const intent = await this.prisma.onlinePaymentIntent.create({
      data: {
        orgId,
        gateway: active.provider,
        amount,
        counterpartyId: invoice.counterpartyId,
        invoiceId: input.invoiceId,
        workOrderId: invoice.workOrderId ?? null,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + INTENT_TTL_MS),
      },
      select: { id: true },
    });

    try {
      const { gatewayInvoiceId, checkoutUrl } = await this.integrationLog.wrap(
        {
          orgId,
          branchId,
          provider: active.provider,
          operation: 'createInvoice',
          documentType: 'OnlinePaymentIntent',
          documentId: intent.id,
        },
        () =>
          gateway.createInvoice(
            { apiUrl: active.apiUrl, credentials: active.credentials },
            { amountCents: Math.round(amount * 100), reference: intent.id },
          ),
      );
      const pageUrl = checkoutUrl;
      const updated = await this.prisma.onlinePaymentIntent.update({
        where: { id: intent.id, orgId },
        data: { gatewayInvoiceId, pageUrl },
        select: {
          id: true,
          status: true,
          pageUrl: true,
          amount: true,
          paymentId: true,
          error: true,
        },
      });
      // Стартуємо polling. Enqueue ПІСЛЯ закомічених intent+gateway-рахунку → offline-first:
      // Redis-down не має валити вже-створений намір HTTP-500 (QR/pageUrl уже є, касир бачить).
      // .catch() дзеркалить delivery/payment-polling процесори; логуємо ERROR (money-critical:
      // без poll-джоба намір не дійде до PAID автоматично — потрібен ручний refresh/повторна спроба).
      await this.pollQueue
        .add(
          'poll',
          { intentId: intent.id, orgId },
          {
            delay: POLL_INTERVAL_MS,
            jobId: `payment-poll-${intent.id}`,
            removeOnComplete: true,
            removeOnFail: 200,
          },
        )
        .catch((err: unknown) =>
          this.logger.error(
            `Черга payment-polling недоступна — намір ${intent.id} без опитування статусу: ${
              err instanceof Error ? err.message : err
            }`,
          ),
        );
      return this.toDto(updated);
    } catch (e) {
      // gateway не створив рахунок → намір FAILED, кидаємо (касир бачить помилку).
      await this.prisma.onlinePaymentIntent
        .update({
          where: { id: intent.id, orgId },
          data: {
            status: 'FAILED',
            error: e instanceof Error ? e.message.slice(0, 500) : 'Помилка',
          },
        })
        .catch(() => undefined);
      throw new BadRequestException(
        translateError('err.onlinePayment.gatewayCreateFailed', getLocale(), {
          name: gateway.name,
          error: e instanceof Error ? e.message : 'помилка',
        }),
      );
    }
  }

  /** Статус наміру (frontend опитує НАШ статус, не monobank напряму). */
  async getIntent(orgId: string, id: string): Promise<OnlineIntentDto> {
    const intent = await this.prisma.onlinePaymentIntent.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true, status: true, pageUrl: true, amount: true, paymentId: true, error: true },
    });
    if (!intent)
      throw new NotFoundException(translateError('err.onlinePayment.intentNotFound', getLocale()));
    return this.toDto(intent);
  }

  private toDto(i: {
    id: string;
    status: string;
    pageUrl: string | null;
    amount: import('@prisma/client').Prisma.Decimal | number;
    paymentId: string | null;
    error: string | null;
  }): OnlineIntentDto {
    return {
      id: i.id,
      status: i.status,
      pageUrl: i.pageUrl,
      amount: Number(i.amount),
      paymentId: i.paymentId,
      error: i.error,
    };
  }
}
