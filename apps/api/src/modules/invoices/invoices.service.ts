import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InvoiceStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { PdfService } from '../pdf/pdf.service';
import {
  CreateInvoiceDto, UpdateInvoiceDto, CreateInvoiceLineDto, UpdateInvoiceLineDto,
  InvoiceLineResponseDto, InvoiceResponseDto, PaginatedInvoicesDto,
} from './invoices.dto';

type InvStatus = InvoiceStatus;

const INV_TRANSITIONS: Record<InvStatus, InvStatus[]> = {
  DRAFT:     [InvoiceStatus.SENT, InvoiceStatus.CANCELLED],
  SENT:      [InvoiceStatus.PAID, InvoiceStatus.CANCELLED],
  PAID:      [],
  OVERDUE:   [InvoiceStatus.PAID, InvoiceStatus.CANCELLED],
  CANCELLED: [],
};

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly docNumbers: DocumentNumberService,
    private readonly pdf: PdfService,
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

    return { items: items.map(item => this.toDto(item)), total, page, limit };
  }

  async findOne(orgId: string, id: string): Promise<InvoiceResponseDto> {
    const inv = await this.prisma.invoice.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        workOrder: { select: { number: true } },
        lines: { orderBy: { sortOrder: 'asc' }, take: 500 },
        payments: { select: { amount: true } },
      },
    });
    if (!inv) throw new NotFoundException('Рахунок не знайдено');
    return this.toDto(inv, true);
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
      where: { workOrderId, orgId, deletedAt: null, status: { not: InvoiceStatus.CANCELLED } },
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

    if (dto.workOrderId) {
      const wo = await this.prisma.workOrder.findFirst({ where: { id: dto.workOrderId, orgId, deletedAt: null } });
      if (!wo) throw new NotFoundException('Наряд не знайдено');
    }

    const number = await this.docNumbers.next(orgId, 'INVOICE');

    const inv = await this.prisma.invoice.create({
      data: {
        orgId,
        counterpartyId: dto.counterpartyId,
        workOrderId: dto.workOrderId ?? null,
        number,
        amount: dto.amount,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        notes: dto.notes ?? null,
        status: InvoiceStatus.DRAFT,
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
    if (inv.status !== InvoiceStatus.DRAFT) throw new BadRequestException('Редагувати можна лише чернетку');

    const updated = await this.prisma.invoice.update({
      where: { id, orgId },
      data: {
        amount: dto.amount ?? undefined,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        notes: dto.notes ?? undefined,
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

  async addLine(orgId: string, invoiceId: string, dto: CreateInvoiceLineDto): Promise<InvoiceLineResponseDto> {
    const inv = await this.prisma.invoice.findFirst({ where: { id: invoiceId, orgId, deletedAt: null } });
    if (!inv) throw new NotFoundException('Рахунок не знайдено');
    if (inv.status !== InvoiceStatus.DRAFT) throw new BadRequestException('Рядки можна додавати лише до чернетки');

    // Cross-tenant FK validation
    if (dto.goodId) {
      const good = await this.prisma.good.findFirst({ where: { id: dto.goodId, orgId, deletedAt: null }, select: { id: true } });
      if (!good) throw new NotFoundException('Запчастину не знайдено');
    }
    if (dto.workId) {
      const work = await this.prisma.work.findFirst({ where: { id: dto.workId, orgId, deletedAt: null }, select: { id: true } });
      if (!work) throw new NotFoundException('Роботу не знайдено');
    }

    const vatRate = dto.vatRate ?? 20;
    const priceWithoutVat = dto.quantity * dto.unitPrice;
    const vatAmount = priceWithoutVat * (vatRate / 100);
    const priceWithVat = priceWithoutVat + vatAmount;

    const line = await this.prisma.invoiceLine.create({
      data: {
        orgId,
        invoiceId,
        goodId: dto.goodId ?? null,
        workId: dto.workId ?? null,
        description: dto.description,
        quantity: dto.quantity,
        unitPrice: dto.unitPrice,
        vatRate,
        priceWithoutVat,
        vatAmount,
        priceWithVat,
        sortOrder: dto.sortOrder ?? 0,
      },
    });

    await this.recalcTotals(orgId, invoiceId);
    return this.toLineDto(line);
  }

  async updateLine(orgId: string, invoiceId: string, lineId: string, dto: UpdateInvoiceLineDto): Promise<InvoiceLineResponseDto> {
    const inv = await this.prisma.invoice.findFirst({ where: { id: invoiceId, orgId, deletedAt: null } });
    if (!inv) throw new NotFoundException('Рахунок не знайдено');
    if (inv.status !== InvoiceStatus.DRAFT) throw new BadRequestException('Рядки можна редагувати лише у чернетці');

    const existing = await this.prisma.invoiceLine.findFirst({ where: { id: lineId, invoiceId, orgId } });
    if (!existing) throw new NotFoundException('Рядок не знайдено');

    const quantity = dto.quantity ?? existing.quantity;
    const unitPrice = dto.unitPrice !== undefined ? dto.unitPrice : Number(existing.unitPrice);
    const vatRate = dto.vatRate !== undefined ? dto.vatRate : Number(existing.vatRate);
    const priceWithoutVat = quantity * unitPrice;
    const vatAmount = priceWithoutVat * (vatRate / 100);
    const priceWithVat = priceWithoutVat + vatAmount;

    const updated = await this.prisma.invoiceLine.update({
      where: { id: lineId },
      data: {
        description: dto.description ?? undefined,
        quantity,
        unitPrice,
        vatRate,
        priceWithoutVat,
        vatAmount,
        priceWithVat,
        sortOrder: dto.sortOrder ?? undefined,
      },
    });

    await this.recalcTotals(orgId, invoiceId);
    return this.toLineDto(updated);
  }

  async removeLine(orgId: string, invoiceId: string, lineId: string): Promise<void> {
    const inv = await this.prisma.invoice.findFirst({ where: { id: invoiceId, orgId, deletedAt: null } });
    if (!inv) throw new NotFoundException('Рахунок не знайдено');
    if (inv.status !== InvoiceStatus.DRAFT) throw new BadRequestException('Рядки можна видаляти лише з чернетки');

    const existing = await this.prisma.invoiceLine.findFirst({ where: { id: lineId, invoiceId, orgId } });
    if (!existing) throw new NotFoundException('Рядок не знайдено');

    await this.prisma.invoiceLine.delete({ where: { id: lineId } });
    await this.recalcTotals(orgId, invoiceId);
  }

  private async recalcTotals(orgId: string, invoiceId: string): Promise<void> {
    const lines = await this.prisma.invoiceLine.findMany({ where: { invoiceId, orgId }, take: 1000 });
    const totalWithoutVat = lines.reduce((s, l) => s + Number(l.priceWithoutVat), 0);
    const totalVat = lines.reduce((s, l) => s + Number(l.vatAmount), 0);
    const totalWithVat = lines.reduce((s, l) => s + Number(l.priceWithVat), 0);

    // Bug #76: prior code had a dead ternary (`totalWithVat || lines.length === 0 ? totalWithVat : totalWithVat`).
    // Both branches identical → result always equals totalWithVat. Use it directly.
    await this.prisma.invoice.update({
      where: { id: invoiceId, orgId },
      data: { totalWithoutVat, totalVat, totalWithVat, amount: totalWithVat },
    });
  }

  async remove(orgId: string, id: string): Promise<void> {
    const inv = await this.prisma.invoice.findFirst({ where: { id, orgId, deletedAt: null } });
    if (!inv) throw new NotFoundException('Рахунок не знайдено');
    if (inv.status !== InvoiceStatus.DRAFT) throw new BadRequestException('Видалити можна лише чернетку');
    await this.prisma.invoice.update({ where: { id, orgId }, data: { deletedAt: new Date() } });
  }

  private toDto(inv: {
    id: string; orgId: string; number: string; status: InvoiceStatus;
    counterpartyId: string; workOrderId: string | null;
    amount: Prisma.Decimal; totalWithoutVat: Prisma.Decimal; totalVat: Prisma.Decimal; totalWithVat: Prisma.Decimal;
    invoiceType: string; notes: string | null;
    dueDate: Date | null; createdAt: Date; updatedAt: Date;
    counterparty: { firstName: string | null; lastName: string | null; companyName: string | null } | null;
    workOrder: { number: string } | null;
    payments?: Array<{ amount: Prisma.Decimal }>;
    lines?: Array<{
      id: string; invoiceId: string; goodId: string | null; workId: string | null;
      description: string; quantity: number; unitPrice: Prisma.Decimal; vatRate: Prisma.Decimal;
      priceWithoutVat: Prisma.Decimal; vatAmount: Prisma.Decimal; priceWithVat: Prisma.Decimal;
      sortOrder: number; createdAt: Date;
    }>;
  }, includeLines = false): InvoiceResponseDto {
    const cp = inv.counterparty;
    const counterpartyName = cp?.companyName ?? [cp?.lastName, cp?.firstName].filter(Boolean).join(' ');
    const paidAmount = inv.payments ? inv.payments.reduce((s, p) => s + Number(p.amount), 0) : undefined;
    return {
      id: inv.id, orgId: inv.orgId, number: inv.number, status: inv.status,
      counterpartyId: inv.counterpartyId, counterpartyName,
      workOrderId: inv.workOrderId ?? null,
      workOrderNumber: inv.workOrder?.number ?? null,
      amount: Number(inv.amount),
      totalWithoutVat: Number(inv.totalWithoutVat),
      totalVat: Number(inv.totalVat),
      totalWithVat: Number(inv.totalWithVat),
      invoiceType: inv.invoiceType,
      notes: inv.notes,
      dueDate: inv.dueDate ?? null,
      ...(paidAmount !== undefined ? { paidAmount } : {}),
      ...(includeLines && inv.lines ? { lines: inv.lines.map(l => this.toLineDto(l)) } : {}),
      createdAt: inv.createdAt, updatedAt: inv.updatedAt,
    };
  }

  async generatePdf(orgId: string, id: string): Promise<Buffer> {
    const [inv, org] = await Promise.all([
      this.prisma.invoice.findFirst({
        where: { id, orgId, deletedAt: null },
        include: {
          counterparty: { select: { firstName: true, lastName: true, companyName: true, phone: true, edrpou: true } },
          lines: { orderBy: { sortOrder: 'asc' }, take: 500 },
        },
      }),
      this.prisma.organisation.findFirst({ where: { id: orgId }, select: { name: true, edrpou: true } }),
    ]);
    if (!inv) throw new NotFoundException('Рахунок не знайдено');

    const cp = inv.counterparty;
    const counterpartyName = cp?.companyName ?? [cp?.lastName, cp?.firstName].filter(Boolean).join(' ') ?? '';

    return this.pdf.generateInvoicePdf({
      org: { name: org?.name ?? '', edrpou: org?.edrpou },
      counterparty: { name: counterpartyName, phone: cp?.phone, edrpou: cp?.edrpou },
      number: inv.number,
      date: inv.createdAt,
      dueDate: inv.dueDate,
      lines: (inv.lines ?? []).map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unit: 'шт',
        unitPrice: Number(l.unitPrice),
        vatRate: Number(l.vatRate),
        total: Number(l.priceWithVat),
      })),
      subtotal: Number(inv.totalWithoutVat),
      vatTotal: Number(inv.totalVat),
      grandTotal: Number(inv.totalWithVat),
    });
  }

  private toLineDto(l: {
    id: string; invoiceId: string; goodId: string | null; workId: string | null;
    description: string; quantity: number; unitPrice: Prisma.Decimal; vatRate: Prisma.Decimal;
    priceWithoutVat: Prisma.Decimal; vatAmount: Prisma.Decimal; priceWithVat: Prisma.Decimal;
    sortOrder: number; createdAt: Date;
  }): InvoiceLineResponseDto {
    return {
      id: l.id, invoiceId: l.invoiceId, goodId: l.goodId, workId: l.workId,
      description: l.description, quantity: l.quantity,
      unitPrice: Number(l.unitPrice), vatRate: Number(l.vatRate),
      priceWithoutVat: Number(l.priceWithoutVat), vatAmount: Number(l.vatAmount),
      priceWithVat: Number(l.priceWithVat), sortOrder: l.sortOrder, createdAt: l.createdAt,
    };
  }
}
