import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { formatPersonName } from '@sto/shared';
import { Queue } from 'bull';
import { PrismaService } from '../../prisma/prisma.service';
import { SettlementsService } from '../settlements/settlements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreatePaymentDto, PaymentResponseDto, PaginatedPaymentsDto } from './payments.dto';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settlements: SettlementsService,
    private readonly notifications: NotificationsService,
    @InjectQueue('checkbox') private readonly checkboxQueue: Queue,
  ) {}

  async findAll(orgId: string, page = 1, limit = 20, counterpartyId?: string): Promise<PaginatedPaymentsDto> {
    const where: { orgId: string; counterpartyId?: string } = { orgId };
    if (counterpartyId) {
      // Verify the counterparty belongs to this org to prevent cross-tenant data leaks
      const cp = await this.prisma.counterparty.findFirst({ where: { id: counterpartyId, orgId, deletedAt: null }, select: { id: true } });
      if (!cp) throw new NotFoundException('Контрагента не знайдено');
      where.counterpartyId = counterpartyId;
    }

    const skip = (page - 1) * limit;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where, skip, take: limit, orderBy: { createdAt: 'desc' },
        include: {
          counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        },
      }),
      this.prisma.payment.count({ where }),
    ]);

    return { items: items.map(this.toDto), total, page, limit };
  }

  async create(orgId: string, dto: CreatePaymentDto, userId?: string): Promise<PaymentResponseDto> {
    const [counterparty, workOrder] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: dto.counterpartyId, orgId, deletedAt: null },
        select: { id: true, phone: true, firstName: true, lastName: true, companyName: true },
      }),
      dto.workOrderId
        ? this.prisma.workOrder.findFirst({ where: { id: dto.workOrderId, orgId, deletedAt: null }, select: { branchId: true } })
        : Promise.resolve(null),
    ]);
    if (!counterparty) throw new NotFoundException('Контрагента не знайдено');

    const payment = await this.prisma.$transaction(async (tx) => {
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

      // Update settlement account
      await this.settlements.createTransaction(orgId, {
        counterpartyId: dto.counterpartyId,
        type: 'PAYMENT',
        amount: dto.amount,
        documentType: 'Payment',
        documentId: created.id,
        createdBy: userId,
      }, tx);

      // Mark invoice SENT→PAID if linked
      if (dto.invoiceId) {
        const inv = await tx.invoice.findFirst({ where: { id: dto.invoiceId, orgId, deletedAt: null } });
        if (inv) {
          if (inv.status !== 'SENT') throw new BadRequestException(`Рахунок у статусі "${inv.status}" — оплата неможлива`);
          await tx.invoice.update({ where: { id: dto.invoiceId }, data: { status: 'PAID' } });
        }
      }

      // Mark work order INVOICED→PAID if linked and increment paidAmount for partial payment tracking
      if (dto.workOrderId) {
        const wo = await tx.workOrder.findFirst({ where: { id: dto.workOrderId, orgId, deletedAt: null } });
        if (wo) {
          if (wo.status !== 'INVOICED') throw new BadRequestException(`Наряд у статусі "${wo.status}" — оплата неможлива`);
          await tx.workOrder.update({
            where: { id: dto.workOrderId },
            data: { status: 'PAID', paidAmount: { increment: dto.amount } },
          });
        }
      }

      return created;
    });

    // Notify counterparty about payment received
    if (counterparty.phone) {
      this.notifications.send(orgId, 'PAYMENT_RECEIVED', {
        phone: counterparty.phone,
        amount: dto.amount.toLocaleString('uk-UA', { minimumFractionDigits: 2 }),
        clientName: formatPersonName(counterparty.lastName, counterparty.firstName, counterparty.companyName),
      }).catch(() => {/* non-critical */});
    }

    // Enqueue Checkbox fiscal receipt (offline-first: retry 288 times = 24h)
    await this.checkboxQueue.add('fiscal-receipt', {
      paymentId: payment.id,
      orgId,
      branchId: workOrder?.branchId ?? null,
      amount: dto.amount,
      method: dto.method,
    }, {
      attempts: 288,
      backoff: { type: 'exponential', delay: 300_000 }, // 5 min initial
      removeOnComplete: true,
    });

    return this.toDto(payment);
  }

  private toDto(p: {
    id: string; orgId: string; counterpartyId: string; workOrderId: string | null;
    invoiceId: string | null; amount: { toString(): string }; method: string;
    notes: string | null; fiscalReceiptId: string | null; createdAt: Date;
    counterparty: { companyName: string | null; lastName: string | null; firstName: string | null } | null;
  }): PaymentResponseDto {
    const cp = p.counterparty;
    const counterpartyName = formatPersonName(cp?.lastName, cp?.firstName, cp?.companyName);
    return {
      id: p.id, orgId: p.orgId,
      counterpartyId: p.counterpartyId, counterpartyName,
      workOrderId: p.workOrderId ?? null,
      invoiceId: p.invoiceId ?? null,
      amount: Number(p.amount),
      method: p.method,
      notes: p.notes ?? null,
      fiscalReceiptId: p.fiscalReceiptId ?? null,
      createdAt: p.createdAt,
    };
  }
}
