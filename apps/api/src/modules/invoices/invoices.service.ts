import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import {
  CreateInvoiceDto, UpdateInvoiceDto,
  InvoiceResponseDto, PaginatedInvoicesDto,
} from './invoices.dto';

const INV_STATUSES = ['DRAFT', 'SENT', 'PAID', 'CANCELLED'] as const;
type InvStatus = typeof INV_STATUSES[number];

const INV_TRANSITIONS: Record<InvStatus, InvStatus[]> = {
  DRAFT:     ['SENT', 'CANCELLED'],
  SENT:      ['PAID', 'CANCELLED'],
  PAID:      [],
  CANCELLED: [],
};

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly docNumbers: DocumentNumberService,
  ) {}

  async findAll(orgId: string, page = 1, limit = 20, status?: string): Promise<PaginatedInvoicesDto> {
    const where: Prisma.InvoiceWhereInput = { orgId, deletedAt: null };
    if (status) where.status = status as InvStatus;

    const skip = (page - 1) * limit;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.invoice.findMany({
        where, skip, take: limit, orderBy: { createdAt: 'desc' },
        include: {
          counterparty: { select: { firstName: true, lastName: true, companyName: true } },
          workOrder: { select: { number: true } },
        },
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return { items: items.map(this.toDto), total, page, limit };
  }

  async findOne(orgId: string, id: string): Promise<InvoiceResponseDto> {
    const inv = await this.prisma.invoice.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        workOrder: { select: { number: true } },
      },
    });
    if (!inv) throw new NotFoundException('Рахунок не знайдено');
    return this.toDto(inv);
  }

  async createFromWorkOrder(orgId: string, workOrderId: string, userId?: string): Promise<InvoiceResponseDto> {
    const wo = await this.prisma.workOrder.findFirst({
      where: { id: workOrderId, orgId, deletedAt: null },
    });
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    if (!['COMPLETED', 'INVOICED'].includes(wo.status)) {
      throw new BadRequestException('Рахунок можна виставити лише для завершеного наряду');
    }

    const existing = await this.prisma.invoice.findFirst({
      where: { workOrderId, orgId, deletedAt: null, status: { not: 'CANCELLED' } },
    });
    if (existing) throw new BadRequestException('Для цього наряду вже існує активний рахунок');

    return this.create(orgId, {
      counterpartyId: wo.counterpartyId,
      workOrderId: wo.id,
      amount: Number(wo.totalAmount),
    }, userId);
  }

  async create(orgId: string, dto: CreateInvoiceDto, userId?: string): Promise<InvoiceResponseDto> {
    const counterparty = await this.prisma.counterparty.findFirst({
      where: { id: dto.counterpartyId, orgId, deletedAt: null },
    });
    if (!counterparty) throw new NotFoundException('Контрагента не знайдено');

    const number = await this.docNumbers.next(orgId, 'INVOICE');

    const inv = await this.prisma.invoice.create({
      data: {
        orgId,
        counterpartyId: dto.counterpartyId,
        workOrderId: dto.workOrderId ?? null,
        number,
        amount: dto.amount,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        status: 'DRAFT',
      },
      include: {
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        workOrder: { select: { number: true } },
      },
    });

    return this.toDto(inv);
  }

  async update(orgId: string, id: string, dto: UpdateInvoiceDto): Promise<InvoiceResponseDto> {
    const inv = await this.prisma.invoice.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!inv) throw new NotFoundException('Рахунок не знайдено');
    if (inv.status !== 'DRAFT') throw new BadRequestException('Редагувати можна лише чернетку');

    const updated = await this.prisma.invoice.update({
      where: { id, orgId },
      data: {
        amount: dto.amount ?? undefined,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      },
      include: {
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        workOrder: { select: { number: true } },
      },
    });

    return this.toDto(updated);
  }

  async transition(orgId: string, id: string, newStatus: InvStatus): Promise<InvoiceResponseDto> {
    const inv = await this.prisma.invoice.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!inv) throw new NotFoundException('Рахунок не знайдено');

    const allowed = INV_TRANSITIONS[inv.status as InvStatus] ?? [];
    if (!allowed.includes(newStatus)) {
      throw new BadRequestException(`Перехід зі статусу "${inv.status}" в "${newStatus}" неможливий`);
    }

    await this.prisma.invoice.update({ where: { id, orgId }, data: { status: newStatus } });
    return this.findOne(orgId, id);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const inv = await this.prisma.invoice.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!inv) throw new NotFoundException('Рахунок не знайдено');
    if (inv.status !== 'DRAFT') throw new BadRequestException('Видалити можна лише чернетку');
    await this.prisma.invoice.update({ where: { id, orgId }, data: { deletedAt: new Date() } });
  }

  private toDto(inv: {
    id: string; orgId: string; number: string; status: string;
    counterpartyId: string; workOrderId: string | null; amount: object;
    dueDate: Date | null; createdAt: Date; updatedAt: Date;
    counterparty: { firstName: string | null; lastName: string | null; companyName: string | null } | null;
    workOrder: { number: string } | null;
  }): InvoiceResponseDto {
    const cp = inv.counterparty;
    const counterpartyName = cp?.companyName ?? [cp?.lastName, cp?.firstName].filter(Boolean).join(' ');
    return {
      id: inv.id, orgId: inv.orgId, number: inv.number, status: inv.status,
      counterpartyId: inv.counterpartyId, counterpartyName,
      workOrderId: inv.workOrderId ?? null,
      workOrderNumber: inv.workOrder?.number ?? null,
      amount: Number(inv.amount),
      dueDate: inv.dueDate ?? null,
      createdAt: inv.createdAt, updatedAt: inv.updatedAt,
    };
  }
}
