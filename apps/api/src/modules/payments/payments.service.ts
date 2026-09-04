import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { formatPersonName, TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { SettlementsService } from '../settlements/settlements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WorkOrdersService } from '../work-orders/work-orders.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { CreatePaymentDto, PaymentResponseDto, PaginatedPaymentsDto } from './payments.dto';

// Module-level Intl singleton — `.toLocaleString('uk-UA', {...})` instantiates a fresh
// Intl.NumberFormat under the hood per call. Used on every payment.create when SMS sent.
const UAH_AMOUNT_FMT = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2 });

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settlements: SettlementsService,
    private readonly notifications: NotificationsService,
    private readonly workOrders: WorkOrdersService,
    private readonly loyalty: LoyaltyService,
    @InjectQueue('checkbox') private readonly checkboxQueue: Queue,
  ) {}

  async findAll(
    orgId: string,
    page = 1,
    limit = 20,
    counterpartyId?: string,
  ): Promise<PaginatedPaymentsDto> {
    // DoS hardening: cap user-controlled pagination params.
    // payments grows monotonically (1 row per money operation); without cap
    // `?limit=999999` could OOM the API on long-running orgs.
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const safePage = Math.max(page, 1);

    const where: { orgId: string; counterpartyId?: string } = { orgId };
    if (counterpartyId) {
      // Verify the counterparty belongs to this org to prevent cross-tenant data leaks
      const cp = await this.prisma.counterparty.findFirst({
        where: { id: counterpartyId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!cp) throw new NotFoundException('Контрагента не знайдено');
      where.counterpartyId = counterpartyId;
    }

    const skip = (safePage - 1) * safeLimit;
    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        include: {
          counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        },
      }),
      this.prisma.payment.count({ where }),
    ]);

    return { items: items.map(item => this.toDto(item)), total, page: safePage, limit: safeLimit };
  }

  async create(orgId: string, dto: CreatePaymentDto, userId?: string): Promise<PaymentResponseDto> {
    // Single parallel batch — counterparty + workOrder (with both branchId + status
    // selected in one query, replacing the prior duplicate findFirst calls).
    const [counterparty, workOrder] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: dto.counterpartyId, orgId, deletedAt: null },
        select: { id: true, phone: true, firstName: true, lastName: true, companyName: true },
      }),
      dto.workOrderId
        ? this.prisma.workOrder.findFirst({
            where: { id: dto.workOrderId, orgId, deletedAt: null },
            select: { branchId: true, status: true },
          })
        : Promise.resolve(null),
    ]);
    if (!counterparty) throw new NotFoundException('Контрагента не знайдено');

    // Pre-validate work order status before opening transaction to avoid partial commit.
    // Status was fetched in the parallel batch above — no extra query needed.
    if (dto.workOrderId && workOrder && workOrder.status !== 'INVOICED') {
      throw new BadRequestException(`Наряд у статусі "${workOrder.status}" — оплата неможлива`);
    }

    const payment = await this.prisma.$transaction(
      async tx => {
        // FIN-C1: ідемпотентність оплати. Перевірку статусу інвойсу й перехід SENT→PAID робимо
        // ПЕРШИМИ і через compare-and-swap (updateMany з status:'SENT' у where). Два concurrent
        // create бачать SENT на stale-read, але лише ОДИН updateMany змінить count=1 — другий
        // отримає count=0 → throw → rollback (без другого Payment/PAYMENT-settlement/чека).
        if (dto.invoiceId) {
          const inv = await tx.invoice.findFirst({
            where: { id: dto.invoiceId, orgId, deletedAt: null },
            select: { status: true, workOrderId: true },
          });
          if (inv) {
            if (inv.status !== 'SENT')
              throw new BadRequestException(`Рахунок у статусі "${inv.status}" — оплата неможлива`);
            // Cross-reference guard: рахунок має належати вказаному наряду.
            if (dto.workOrderId && inv.workOrderId && inv.workOrderId !== dto.workOrderId) {
              throw new BadRequestException('Рахунок не належить до вказаного наряду');
            }
            // CAS: атомарний перехід SENT→PAID. count=0 → інший конкурентний платіж уже провів.
            const paid = await tx.invoice.updateMany({
              where: { id: dto.invoiceId, orgId, status: 'SENT', deletedAt: null },
              data: { status: 'PAID' },
            });
            if (paid.count === 0) {
              throw new BadRequestException('Рахунок уже оплачено (паралельна операція)');
            }
          }
        }

        const created = await tx.payment.create({
          data: {
            orgId,
            counterpartyId: dto.counterpartyId,
            workOrderId: dto.workOrderId ?? null,
            invoiceId: dto.invoiceId ?? null,
            amount: dto.amount,
            method: dto.method,
            notes: dto.notes ?? null,
          },
          include: {
            counterparty: { select: { firstName: true, lastName: true, companyName: true } },
          },
        });

        await this.settlements.createTransaction(
          orgId,
          {
            counterpartyId: dto.counterpartyId,
            type: 'PAYMENT',
            amount: dto.amount,
            documentType: 'Payment',
            documentId: created.id,
            createdBy: userId,
          },
          tx,
        );

        if (dto.workOrderId) {
          await tx.workOrder.update({
            where: { id: dto.workOrderId, orgId },
            data: { paidAmount: { increment: dto.amount } },
          });
        }

        return created;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // explicit timeout — payment + settlement + invoice/WO updates

    // FSM INVOICED→PAID outside tx (WorkOrdersService has its own tx). Safe: payment + settlement
    // already committed; if transition fails, operator retries status manually.
    if (dto.workOrderId) {
      await this.workOrders
        .transition(orgId, dto.workOrderId, 'PAID', userId)
        .catch((e: unknown) => {
          this.logger.warn(
            `Не вдалось перевести наряд ${dto.workOrderId} у статус PAID після оплати: ${e instanceof Error ? e.message : e}`,
          );
        });
    }

    if (counterparty.phone) {
      this.notifications
        .send(orgId, 'PAYMENT_RECEIVED', {
          phone: counterparty.phone,
          amount: UAH_AMOUNT_FMT.format(dto.amount),
          clientName: formatPersonName(
            counterparty.lastName,
            counterparty.firstName,
            counterparty.companyName,
          ),
        })
        .catch((err: unknown) =>
          this.logger.warn(
            `Payment notification failed: ${err instanceof Error ? err.message : err}`,
          ),
        );
    }

    // Enqueue Checkbox fiscal receipt (offline-first: retry 288 times = 24h)
    await this.checkboxQueue.add(
      'fiscal-receipt',
      {
        paymentId: payment.id,
        orgId,
        branchId: workOrder?.branchId ?? null,
        amount: dto.amount,
        method: dto.method,
      },
      {
        attempts: 288,
        backoff: { type: 'exponential', delay: 300_000 }, // 5 min initial
        removeOnComplete: true,
      },
    );

    // Non-blocking loyalty earn: if queue is down, log warning, payment stands.
    // BullMQ job checks OrganisationSettings.loyaltyEnabled — exits without writing if disabled.
    await this.loyalty
      .queueEarn(orgId, dto.counterpartyId, dto.amount, payment.id)
      .catch((err: unknown) =>
        this.logger.warn(
          `Loyalty earn enqueue failed: ${err instanceof Error ? err.message : err}`,
        ),
      );

    return this.toDto(payment);
  }

  private toDto(p: {
    id: string;
    orgId: string;
    counterpartyId: string;
    workOrderId: string | null;
    invoiceId: string | null;
    amount: import('@prisma/client').Prisma.Decimal;
    method: string;
    notes: string | null;
    fiscalReceiptId: string | null;
    createdAt: Date;
    counterparty: {
      companyName: string | null;
      lastName: string | null;
      firstName: string | null;
    } | null;
  }): PaymentResponseDto {
    const cp = p.counterparty;
    const counterpartyName = formatPersonName(cp?.lastName, cp?.firstName, cp?.companyName);
    return {
      id: p.id,
      orgId: p.orgId,
      counterpartyId: p.counterpartyId,
      counterpartyName,
      workOrderId: p.workOrderId ?? null,
      invoiceId: p.invoiceId ?? null,
      amount: Number(p.amount),
      method: p.method,
      notes: p.notes ?? null,
      fiscalReceiptId: p.fiscalReceiptId ?? null,
      createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
    };
  }
}
