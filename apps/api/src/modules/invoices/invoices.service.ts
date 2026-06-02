import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InvoiceStatus, Prisma } from '@prisma/client';
import { formatPersonName } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { PdfService } from '../pdf/pdf.service';
import {
  CreateInvoiceDto,
  UpdateInvoiceDto,
  CreateInvoiceLineDto,
  UpdateInvoiceLineDto,
  InvoiceLineResponseDto,
  InvoiceResponseDto,
  PaginatedInvoicesDto,
} from './invoices.dto';

type InvStatus = InvoiceStatus;

const INV_TRANSITIONS: Record<InvStatus, InvStatus[]> = {
  DRAFT: [InvoiceStatus.SENT, InvoiceStatus.CANCELLED],
  SENT: [InvoiceStatus.PAID, InvoiceStatus.CANCELLED],
  PAID: [],
  OVERDUE: [InvoiceStatus.PAID, InvoiceStatus.CANCELLED],
  CANCELLED: [],
};

/**
 * Bug #316: defense-in-depth для coefficient як дільника.
 * DTO `@Min(0.000001)` блокує coefficient=0 на write-path, але legacy/seed/CSV-import дані
 * можуть мати 0. `?? 1` НЕ ловить 0 (nullish coalescing спрацьовує лише на null/undefined).
 * `safeCoeff` повертає 1 для null/undefined/0/NaN/негативних значень.
 */
function safeCoeff(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 1;
  return value;
}

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly docNumbers: DocumentNumberService,
    private readonly pdf: PdfService,
  ) {}

  async findAll(
    orgId: string,
    page = 1,
    limit = 20,
    status?: string,
  ): Promise<PaginatedInvoicesDto> {
    const where: Prisma.InvoiceWhereInput = { orgId, deletedAt: null };
    if (status) where.status = status as InvStatus;

    const skip = (page - 1) * limit;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.invoice.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
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
        // Bug #232: include good.unit + unitOfMeasure щоб InvoiceLineResponseDto.unitShortName/coefficient
        // не були завжди undefined. Krok 3 додав ці поля у DTO але includes не оновили.
        lines: {
          orderBy: { sortOrder: 'asc' },
          take: 500,
          include: {
            good: {
              select: {
                unit: true,
                unitOfMeasure: { select: { shortName: true, coefficient: true } },
              },
            },
          },
        },
        payments: { select: { amount: true } },
      },
    });
    if (!inv) throw new NotFoundException('Рахунок не знайдено');
    return this.toDto(inv, true);
  }

  async createFromWorkOrder(
    orgId: string,
    workOrderId: string,
    userId?: string,
  ): Promise<InvoiceResponseDto> {
    // Tenant-guard + duplicate-check run independently — both already filter by
    // orgId so cross-tenant data cannot leak. Saves 1 RTT vs sequential.
    const [wo, existing] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id: workOrderId, orgId, deletedAt: null },
      }),
      this.prisma.invoice.findFirst({
        where: { workOrderId, orgId, deletedAt: null, status: { not: InvoiceStatus.CANCELLED } },
      }),
    ]);
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    if (!['COMPLETED', 'INVOICED'].includes(wo.status)) {
      throw new BadRequestException('Рахунок можна виставити лише для завершеного наряду');
    }
    if (existing) throw new BadRequestException('Для цього наряду вже існує активний рахунок');

    return this.create(
      orgId,
      {
        counterpartyId: wo.counterpartyId,
        workOrderId: wo.id,
        amount: Number(wo.totalAmount),
      },
      userId,
    );
  }

  async create(orgId: string, dto: CreateInvoiceDto, userId?: string): Promise<InvoiceResponseDto> {
    // Validate counterparty + workOrder in parallel instead of sequential round-trips
    const [counterparty, wo] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: dto.counterpartyId, orgId, deletedAt: null },
      }),
      dto.workOrderId
        ? this.prisma.workOrder.findFirst({
            where: { id: dto.workOrderId, orgId, deletedAt: null },
          })
        : Promise.resolve(null),
    ]);
    if (!counterparty) throw new NotFoundException('Контрагента не знайдено');
    if (dto.workOrderId && !wo) throw new NotFoundException('Наряд не знайдено');

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
    if (inv.status !== InvoiceStatus.DRAFT)
      throw new BadRequestException('Редагувати можна лише чернетку');

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
      throw new BadRequestException(
        `Перехід зі статусу "${inv.status}" в "${newStatus}" неможливий`,
      );
    }

    await this.prisma.invoice.update({ where: { id, orgId }, data: { status: newStatus } });
    return this.findOne(orgId, id);
  }

  async clone(orgId: string, id: string): Promise<InvoiceResponseDto> {
    // 1. Find original invoice with lines
    const original = await this.prisma.invoice.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        workOrder: { select: { number: true } },
        // Bug #232: include good.unitOfMeasure для коректного toDto(true) на завершенні clone.
        lines: {
          orderBy: { sortOrder: 'asc' },
          take: 500,
          include: {
            good: {
              select: {
                unit: true,
                unitOfMeasure: { select: { shortName: true, coefficient: true } },
              },
            },
          },
        },
      },
    });
    if (!original) throw new NotFoundException('Рахунок не знайдено');

    // Bug #90: validate counterparty still exists (not soft-deleted) BEFORE create.
    // Otherwise Prisma P2003 surfaces as HTTP 500 instead of a friendly 404.
    const counterparty = await this.prisma.counterparty.findFirst({
      where: { id: original.counterpartyId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!counterparty)
      throw new NotFoundException('Контрагента було видалено — клонування неможливе');

    // 2. Get new number
    const number = await this.docNumbers.next(orgId, 'INVOICE');

    // 3. Pre-compute VAT totals from original's lines so the cloned invoice
    // ships consistent totalWithoutVat/totalVat/totalWithVat (Bug #82). Without
    // this, Prisma defaults leave them at 0 while lines[].priceWithVat has real values.
    const totalWithoutVat = original.lines.reduce((s, l) => s + Number(l.priceWithoutVat), 0);
    const totalVat = original.lines.reduce((s, l) => s + Number(l.vatAmount), 0);
    const totalWithVat = original.lines.reduce((s, l) => s + Number(l.priceWithVat), 0);

    // 4. Create cloned invoice as DRAFT
    // Bug #91: clone is a standalone invoice — must NOT inherit workOrderId,
    // otherwise the same WO accumulates duplicate invoices and the WO→Invoice
    // 1:1 invariant breaks (auto-invoice on completion would create a 3rd).
    const cloned = await this.prisma.invoice.create({
      data: {
        orgId,
        counterpartyId: original.counterpartyId,
        workOrderId: null,
        number,
        // When the invoice has line items, sync `amount` with their total to
        // avoid mismatch between `amount` and recalculated VAT breakdown.
        // Fall back to `original.amount` when there are no lines.
        amount: original.lines.length > 0 ? totalWithVat : original.amount,
        totalWithoutVat,
        totalVat,
        totalWithVat,
        dueDate: original.dueDate,
        notes: original.notes,
        status: InvoiceStatus.DRAFT,
        lines: {
          create: original.lines.map(l => ({
            orgId,
            goodId: l.goodId,
            workId: l.workId,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            vatRate: l.vatRate,
            priceWithoutVat: l.priceWithoutVat,
            vatAmount: l.vatAmount,
            priceWithVat: l.priceWithVat,
            sortOrder: l.sortOrder,
          })),
        },
      },
      include: {
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        workOrder: { select: { number: true } },
      },
    });

    return this.toDto(cloned);
  }

  async addLine(
    orgId: string,
    invoiceId: string,
    dto: CreateInvoiceLineDto,
  ): Promise<InvoiceLineResponseDto> {
    // Tenant-guard invoice + FK validations (good/work) — all three independent
    // and already orgId-scoped. Saves one RTT vs the previous «invoice-first, then
    // parallel good+work» pattern.
    const [inv, good, work, goodUoM] = await Promise.all([
      this.prisma.invoice.findFirst({
        where: { id: invoiceId, orgId, deletedAt: null },
      }),
      dto.goodId
        ? this.prisma.good.findFirst({
            where: { id: dto.goodId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.workId
        ? this.prisma.work.findFirst({
            where: { id: dto.workId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.unitOfMeasureId && dto.goodId
        ? this.prisma.goodUoM.findFirst({
            where: { id: dto.unitOfMeasureId, goodId: dto.goodId, orgId },
            select: { id: true, coefficient: true, unitOfMeasure: { select: { shortName: true } } },
          })
        : Promise.resolve(null),
    ]);
    if (!inv) throw new NotFoundException('Рахунок не знайдено');
    if (inv.status !== InvoiceStatus.DRAFT)
      throw new BadRequestException('Рядки можна додавати лише до чернетки');
    if (dto.goodId && !good) throw new NotFoundException('Запчастину не знайдено');
    if (dto.workId && !work) throw new NotFoundException('Роботу не знайдено');
    if (dto.unitOfMeasureId && dto.goodId && !goodUoM)
      throw new NotFoundException('Одиницю виміру не знайдено для цього товару');

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
        unitOfMeasureId: dto.unitOfMeasureId ?? null,
      },
      // Bug #232: include good для unitShortName/coefficient у відповіді.
      include: {
        good: {
          select: {
            unit: true,
            unitOfMeasure: { select: { shortName: true, coefficient: true } },
          },
        },
      },
    });

    await this.recalcTotals(orgId, invoiceId);
    return this.toLineDto({ ...line, goodUoM });
  }

  async updateLine(
    orgId: string,
    invoiceId: string,
    lineId: string,
    dto: UpdateInvoiceLineDto,
  ): Promise<InvoiceLineResponseDto> {
    // Independent reads: tenant-guard invoice + existing line. Both queries already
    // tenant-scoped via orgId → safe to parallelize. Throw checks stay after Promise.all
    // so the user still gets the "invoice-first" diagnostic message.
    const [inv, existing] = await Promise.all([
      this.prisma.invoice.findFirst({
        where: { id: invoiceId, orgId, deletedAt: null },
      }),
      this.prisma.invoiceLine.findFirst({
        where: { id: lineId, invoiceId, orgId },
      }),
    ]);
    if (!inv) throw new NotFoundException('Рахунок не знайдено');
    if (inv.status !== InvoiceStatus.DRAFT)
      throw new BadRequestException('Рядки можна редагувати лише у чернетці');
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
      // Bug #232: include good для unitShortName/coefficient у відповіді.
      include: {
        good: {
          select: {
            unit: true,
            unitOfMeasure: { select: { shortName: true, coefficient: true } },
          },
        },
      },
    });

    await this.recalcTotals(orgId, invoiceId);
    return this.toLineDto(updated);
  }

  async removeLine(orgId: string, invoiceId: string, lineId: string): Promise<void> {
    // Parallelize tenant-guard invoice + existing line fetch — both queries are
    // independent and already tenant-scoped via orgId. Saves one RTT per call.
    const [inv, existing] = await Promise.all([
      this.prisma.invoice.findFirst({
        where: { id: invoiceId, orgId, deletedAt: null },
      }),
      this.prisma.invoiceLine.findFirst({
        where: { id: lineId, invoiceId, orgId },
      }),
    ]);
    if (!inv) throw new NotFoundException('Рахунок не знайдено');
    if (inv.status !== InvoiceStatus.DRAFT)
      throw new BadRequestException('Рядки можна видаляти лише з чернетки');
    if (!existing) throw new NotFoundException('Рядок не знайдено');

    // Defense-in-depth: atomic deleteMany with full compound where (sto-review pattern 2026-05-30).
    // Removes the race-window between the findFirst guard above and a plain delete-by-id.
    const result = await this.prisma.invoiceLine.deleteMany({
      where: { id: lineId, invoiceId, orgId },
    });
    if (result.count === 0) throw new NotFoundException('Рядок не знайдено');
    await this.recalcTotals(orgId, invoiceId);
  }

  private async recalcTotals(orgId: string, invoiceId: string): Promise<void> {
    const lines = await this.prisma.invoiceLine.findMany({
      where: { invoiceId, orgId },
      take: 1000,
    });
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
    if (inv.status !== InvoiceStatus.DRAFT)
      throw new BadRequestException('Видалити можна лише чернетку');
    await this.prisma.invoice.update({ where: { id, orgId }, data: { deletedAt: new Date() } });
  }

  private toDto(
    inv: {
      id: string;
      orgId: string;
      number: string;
      status: InvoiceStatus;
      counterpartyId: string;
      workOrderId: string | null;
      amount: Prisma.Decimal;
      totalWithoutVat: Prisma.Decimal;
      totalVat: Prisma.Decimal;
      totalWithVat: Prisma.Decimal;
      invoiceType: string;
      notes: string | null;
      dueDate: Date | null;
      createdAt: Date;
      updatedAt: Date;
      counterparty: {
        firstName: string | null;
        lastName: string | null;
        companyName: string | null;
      } | null;
      workOrder: { number: string } | null;
      payments?: Array<{ amount: Prisma.Decimal }>;
      lines?: Array<{
        id: string;
        invoiceId: string;
        goodId: string | null;
        workId: string | null;
        description: string;
        quantity: number;
        unitPrice: Prisma.Decimal;
        vatRate: Prisma.Decimal;
        priceWithoutVat: Prisma.Decimal;
        vatAmount: Prisma.Decimal;
        priceWithVat: Prisma.Decimal;
        sortOrder: number;
        createdAt: Date;
      }>;
    },
    includeLines = false,
  ): InvoiceResponseDto {
    const cp = inv.counterparty;
    const counterpartyName =
      cp?.companyName ?? [cp?.lastName, cp?.firstName].filter(Boolean).join(' ');
    const paidAmount = inv.payments
      ? inv.payments.reduce((s, p) => s + Number(p.amount), 0)
      : undefined;
    return {
      id: inv.id,
      orgId: inv.orgId,
      number: inv.number,
      status: inv.status,
      counterpartyId: inv.counterpartyId,
      counterpartyName,
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
      createdAt: inv.createdAt,
      updatedAt: inv.updatedAt,
    };
  }

  async generatePdf(orgId: string, id: string): Promise<Buffer> {
    const [inv, org] = await Promise.all([
      this.prisma.invoice.findFirst({
        where: { id, orgId, deletedAt: null },
        // PDF select narrow: тягнемо ЛИШЕ поля що реально рендеряться у docDef.
        // Не використовуються в PDF (раніше over-fetched через include): id/orgId/branchId/cashRegisterId/
        // counterpartyName(parent), counterparty.id/orgId/sync*; lines.id/invoiceId/goodId/workId/sortOrder/
        // priceWithoutVat/vatAmount, good.unit/unitOfMeasure.coefficient (PDF використовує лише shortName).
        select: {
          number: true,
          createdAt: true,
          dueDate: true,
          totalWithoutVat: true,
          totalVat: true,
          totalWithVat: true,
          counterparty: {
            select: {
              firstName: true,
              lastName: true,
              companyName: true,
              phone: true,
              edrpou: true,
            },
          },
          lines: {
            orderBy: { sortOrder: 'asc' },
            take: 500,
            select: {
              description: true,
              quantity: true,
              unitPrice: true,
              vatRate: true,
              priceWithVat: true,
              good: {
                select: {
                  unit: true,
                  unitOfMeasure: { select: { shortName: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.organisation.findFirst({
        where: { id: orgId },
        select: { name: true, edrpou: true },
      }),
    ]);
    if (!inv) throw new NotFoundException('Рахунок не знайдено');

    const cp = inv.counterparty;
    // Bug #269: попередній `cp?.companyName ?? [...].join(' ') ?? ''` мав мертвий `?? ''`
    // після `.join(' ')` (завжди string), і провалював edge-case `companyName=''` (порожній
    // рядок не nullish → `?? [...]` НЕ переходить до lastName/firstName). Уніфіковано з
    // work-orders.service.ts:1016 — `formatPersonName(...) || ''` коректно обробляє
    // companyName=null/undefined/''.
    const counterpartyName = formatPersonName(cp?.lastName, cp?.firstName, cp?.companyName) || '';

    return this.pdf.generateInvoicePdf({
      org: { name: org?.name ?? '', edrpou: org?.edrpou },
      counterparty: { name: counterpartyName, phone: cp?.phone, edrpou: cp?.edrpou },
      number: inv.number,
      date: inv.createdAt,
      dueDate: inv.dueDate,
      lines: (inv.lines ?? []).map(l => ({
        description: l.description,
        quantity: l.quantity,
        // Раніше hardcoded 'шт' — тепер реально використовуємо include що тягне UoM.
        unit: l.good?.unitOfMeasure?.shortName ?? l.good?.unit ?? 'шт',
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
    id: string;
    invoiceId: string;
    goodId: string | null;
    workId: string | null;
    description: string;
    quantity: number;
    unitPrice: Prisma.Decimal;
    vatRate: Prisma.Decimal;
    priceWithoutVat: Prisma.Decimal;
    vatAmount: Prisma.Decimal;
    priceWithVat: Prisma.Decimal;
    sortOrder: number;
    unitOfMeasureId?: string | null;
    createdAt: Date;
    good?: {
      unit: string;
      unitOfMeasure: { shortName: string; coefficient: number } | null;
    } | null;
    goodUoM?: { id: string; coefficient: number; unitOfMeasure: { shortName: string } } | null;
  }): InvoiceLineResponseDto {
    const selectedUoM = l.goodUoM;
    const baseUoM = l.good?.unitOfMeasure;
    return {
      id: l.id,
      invoiceId: l.invoiceId,
      goodId: l.goodId,
      workId: l.workId,
      description: l.description,
      unitOfMeasureId: l.unitOfMeasureId ?? null,
      unitShortName: selectedUoM?.unitOfMeasure.shortName ?? baseUoM?.shortName ?? l.good?.unit,
      // Bug #316: safeCoeff() для legacy/seed 0 — фронт використовує coefficient як дільник для display↔base conversion.
      coefficient: safeCoeff(selectedUoM?.coefficient ?? baseUoM?.coefficient),
      quantity: l.quantity,
      unitPrice: Number(l.unitPrice),
      vatRate: Number(l.vatRate),
      priceWithoutVat: Number(l.priceWithoutVat),
      vatAmount: Number(l.vatAmount),
      priceWithVat: Number(l.priceWithVat),
      sortOrder: l.sortOrder,
      createdAt: l.createdAt,
    };
  }
}
