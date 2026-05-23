import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
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
    const where: any = { orgId };
    if (counterpartyId) where.counterpartyId = counterpartyId;

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
    const counterparty = await this.prisma.counterparty.findFirst({
      where: { id: dto.counterpartyId, orgId, deletedAt: null },
    });
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

      // Mark invoice as PAID if linked and fully paid
      if (dto.invoiceId) {
        const inv = await tx.invoice.findFirst({ where: { id: dto.invoiceId } });
        if (inv && inv.status === 'SENT') {
          await tx.invoice.update({ where: { id: dto.invoiceId }, data: { status: 'PAID' } });
        }
      }

      // Mark work order as INVOICED→PAID if linked
      if (dto.workOrderId) {
        const wo = await tx.workOrder.findFirst({ where: { id: dto.workOrderId } });
        if (wo && wo.status === 'INVOICED') {
          await tx.workOrder.update({ where: { id: dto.workOrderId }, data: { status: 'PAID' } });
        }
      }

      return created;
    });

    // Notify counterparty about payment received
    const cp = await this.prisma.counterparty.findFirst({
      where: { id: dto.counterpartyId, orgId },
      select: { phone: true, firstName: true, lastName: true, companyName: true },
    });
    if (cp?.phone) {
      this.notifications.send(orgId, 'PAYMENT_RECEIVED', {
        phone: cp.phone,
        amount: dto.amount.toLocaleString('uk-UA', { minimumFractionDigits: 2 }),
        clientName: cp.companyName ?? [cp.lastName, cp.firstName].filter(Boolean).join(' '),
      }).catch(() => {/* non-critical */});
    }

    // Enqueue Checkbox fiscal receipt (offline-first: retry 288 times = 24h)
    await this.checkboxQueue.add('fiscal-receipt', {
      paymentId: payment.id,
      orgId,
      amount: dto.amount,
      method: dto.method,
    }, {
      attempts: 288,
      backoff: { type: 'exponential', delay: 300_000 }, // 5 min initial
      removeOnComplete: true,
    });

    return this.toDto(payment);
  }

  private toDto(p: any): PaymentResponseDto {
    const cp = p.counterparty;
    const counterpartyName = cp?.companyName ?? [cp?.lastName, cp?.firstName].filter(Boolean).join(' ');
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
