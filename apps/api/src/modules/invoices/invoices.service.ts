import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InvoiceStatus, Prisma } from '@prisma/client';
import { formatPersonName } from '@sto/shared';

import { kyivToday } from '../../common/utils/kyiv-date';
import { safeCoeff, roundMoney } from '../../common/utils/math';
import { sumLineTotals } from '../../common/utils/vat';
import { calculatePagination, buildSortOrderBy } from '../../common/utils/pagination';
import { assertFsmTransition } from '../../common/utils/fsm';
import { throwIfSerializationConflict } from '../../common/utils/prisma-errors';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import { PdfService } from '../pdf/pdf.service';
import { SettlementsService } from '../settlements/settlements.service';
import { INVOICEABLE_STATUSES } from '../work-orders/work-orders.fsm';
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

// sto-optimize (cycle 3/3): sort-field whitelist hoisted from findAll body — static string-map,
// re-allocated on every list request under polling. Sibling to SP_SORT_FIELDS/WO_SORT/PO_SORT/SD_SORT.
const INV_SORT_FIELDS: Record<string, string> = {
  documentDate: 'documentDate',
  createdAt: 'createdAt',
  dueDate: 'dueDate',
  amount: 'amount',
};

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly docNumbers: DocumentNumberService,
    private readonly pdf: PdfService,
    private readonly settlements: SettlementsService,
  ) {}

  async findAll(
    orgId: string,
    page = 1,
    limit = 20,
    status?: string,
    q?: string,
    showDeleted = false,
    dateFrom?: string,
    dateTo?: string,
    sortBy?: string,
    sortDir?: 'asc' | 'desc',
  ): Promise<PaginatedInvoicesDto> {
    const where: Prisma.InvoiceWhereInput = {
      orgId,
      deletedAt: showDeleted ? undefined : null,
    };
    if (status) where.status = status as InvStatus;
    if (q) {
      const like = q.trim();
      where.OR = [
        { number: { contains: like, mode: 'insensitive' } },
        {
          counterparty: {
            OR: [
              { firstName: { contains: like, mode: 'insensitive' } },
              { lastName: { contains: like, mode: 'insensitive' } },
              { companyName: { contains: like, mode: 'insensitive' } },
            ],
          },
        },
      ];
    }
    if (dateFrom || dateTo) {
      where.documentDate = {
        ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
        ...(dateTo ? { lte: new Date(dateTo + 'T23:59:59.999Z') } : {}),
      };
    }

    const { skip, take } = calculatePagination({ page, limit });
    const orderBy = buildSortOrderBy(INV_SORT_FIELDS, sortBy, sortDir);
    const [items, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        skip,
        take,
        orderBy,
        include: {
          counterparty: { select: { firstName: true, lastName: true, companyName: true } },
          workOrder: { select: { number: true } },
        },
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return { items: items.map(item => this.toDto(item)), total, page, limit: take };
  }

  async findOne(orgId: string, id: string): Promise<InvoiceResponseDto> {
    const inv = await this.prisma.invoice.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        workOrder: { select: { number: true } },
        // good.unit + unitOfMeasure required: unitShortName/coefficient were always undefined
        // until includes were updated to match DTO fields.
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

  async createFromWorkOrder(orgId: string, workOrderId: string): Promise<InvoiceResponseDto> {
    // Pre-tx check WO existence + duplicate for fast 4xx feedback.
    // Race still possible — actual create wrapped in Serializable tx with re-check below.
    const [wo, existingPre] = await Promise.all([
      this.prisma.workOrder.findFirst({
        // sto-optimize: narrow select — використовуються лише id/status/counterpartyId/totalAmount.
        // Full-row guard тягнув би 20+ колонок (vehicle/branch/lift FKs, syncVersion, timestamps)
        // — wire payload зайвий, V8 alloc на гарячому шляху invoice create.
        where: { id: workOrderId, orgId, deletedAt: null },
        select: { id: true, status: true, counterpartyId: true, totalAmount: true },
      }),
      this.prisma.invoice.findFirst({
        where: { workOrderId, orgId, deletedAt: null, status: { not: InvoiceStatus.CANCELLED } },
        select: { id: true },
      }),
    ]);
    if (!wo) throw new NotFoundException('Наряд не знайдено');
    // shared INVOICEABLE_STATUSES: раніше inline `['COMPLETED', 'INVOICED']` — будь-який
    // новий статус у whitelist оновлюється тільки у одному місці.
    if (!INVOICEABLE_STATUSES.includes(wo.status)) {
      throw new BadRequestException('Рахунок можна виставити лише для завершеного наряду');
    }
    if (existingPre) throw new BadRequestException('Для цього наряду вже існує активний рахунок');

    // docNumbers.next() opens its own $tx (SELECT FOR UPDATE counter) — must run BEFORE
    // the outer Serializable tx to avoid nested-tx deadlock. Trade-off: if outer tx aborts
    // we burn one INVOICE number. Acceptable — invoice numbering tolerates gaps (CANCELLED
    // status reservation already creates similar gaps).
    const number = await this.docNumbers.next(orgId, 'INVOICE');

    // Serializable isolation + re-check `existing` within the tx prevents two concurrent
    // createFromWorkOrder calls from BOTH passing the pre-check and creating duplicate invoices.
    // On Serializable conflict, Prisma throws P2034 → map to BadRequestException.
    try {
      const inv = await this.prisma.$transaction(
        async tx => {
          const existing = await tx.invoice.findFirst({
            where: {
              workOrderId,
              orgId,
              deletedAt: null,
              status: { not: InvoiceStatus.CANCELLED },
            },
            select: { id: true },
          });
          if (existing)
            throw new BadRequestException('Для цього наряду вже існує активний рахунок');

          return tx.invoice.create({
            data: {
              orgId,
              counterpartyId: wo.counterpartyId,
              workOrderId: wo.id,
              number,
              amount: Number(wo.totalAmount),
              dueDate: null,
              documentDate: kyivToday(),
              notes: null,
              status: InvoiceStatus.DRAFT,
            },
            include: {
              counterparty: { select: { firstName: true, lastName: true, companyName: true } },
              workOrder: { select: { number: true } },
            },
          });
        },
        { isolationLevel: 'Serializable', timeout: 10_000 },
      );

      return this.toDto(inv);
    } catch (err) {
      throwIfSerializationConflict(
        err,
        'Інший користувач щойно виставив рахунок для цього наряду. Оновіть сторінку.',
      );
    }
  }

  async create(orgId: string, dto: CreateInvoiceDto, userId?: string): Promise<InvoiceResponseDto> {
    // Validate counterparty + workOrder in parallel instead of sequential round-trips.
    // Narrow projection — guards перевіряють лише існування (NotFoundException).
    const [counterparty, wo] = await Promise.all([
      this.prisma.counterparty.findFirst({
        where: { id: dto.counterpartyId, orgId, deletedAt: null },
        select: { id: true },
      }),
      dto.workOrderId
        ? this.prisma.workOrder.findFirst({
            where: { id: dto.workOrderId, orgId, deletedAt: null },
            select: { id: true },
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
        invoiceType: dto.invoiceType ?? 'INVOICE',
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        documentDate: dto.documentDate ? new Date(dto.documentDate) : kyivToday(),
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
    // sto-optimize: status-only projection — guard перевіряє лише DRAFT, всі інші поля ігноруються.
    // Раніше тягнуло amount/dueDate/notes/totalWithVat/syncVersion + counterpartyId/workOrderId/orgId.
    const inv = await this.prisma.invoice.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true },
    });
    if (!inv) throw new NotFoundException('Рахунок не знайдено');
    if (inv.status !== InvoiceStatus.DRAFT)
      throw new BadRequestException('Редагувати можна лише чернетку');

    const updated = await this.prisma.invoice.update({
      where: { id, orgId },
      data: {
        amount: dto.amount ?? undefined,
        invoiceType: dto.invoiceType ?? undefined,
        counterpartyId: dto.counterpartyId ?? undefined,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        documentDate: dto.documentDate ? new Date(dto.documentDate) : undefined,
        notes: dto.notes ?? undefined,
      },
      include: {
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        workOrder: { select: { number: true } },
      },
    });

    return this.toDto(updated);
  }

  async transition(
    orgId: string,
    id: string,
    newStatus: InvStatus,
    userId?: string,
  ): Promise<InvoiceResponseDto> {
    const inv = await this.prisma.invoice.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true, workOrderId: true, counterpartyId: true, amount: true },
    });
    if (!inv) throw new NotFoundException('Рахунок не знайдено');

    assertFsmTransition(INV_TRANSITIONS, inv.status as InvStatus, newStatus);

    // FIN-C2: борг (CHARGE) для STANDALONE-рахунку (без наряду) створюється при виставленні
    // (DRAFT→SENT). WO-рахунок НЕ чіпаємо — там CHARGE вже нараховано при COMPLETED наряду
    // (інакше подвійний борг). Оплата пізніше зробить PAYMENT → net-zero. У тій самій tx +
    // CAS-перехід (status:DRAFT у where) проти подвійного CHARGE при concurrent transition.
    const chargesStandaloneOnSend =
      inv.status === InvoiceStatus.DRAFT &&
      newStatus === InvoiceStatus.SENT &&
      inv.workOrderId === null;

    await this.prisma.$transaction(async tx => {
      const moved = await tx.invoice.updateMany({
        where: { id, orgId, status: inv.status, deletedAt: null },
        data: { status: newStatus },
      });
      if (moved.count === 0) {
        throw new BadRequestException('Статус рахунку змінився — повторіть дію');
      }
      if (chargesStandaloneOnSend) {
        await this.settlements.createTransaction(
          orgId,
          {
            counterpartyId: inv.counterpartyId,
            type: 'CHARGE',
            amount: Number(inv.amount),
            documentType: 'Invoice',
            documentId: id,
            createdBy: userId,
          },
          tx,
        );
      }
    });
    return this.findOne(orgId, id);
  }

  async clone(orgId: string, id: string): Promise<InvoiceResponseDto> {
    const original = await this.prisma.invoice.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        counterparty: { select: { firstName: true, lastName: true, companyName: true } },
        workOrder: { select: { number: true } },
        // good.unitOfMeasure required for correct toDto(true) on clone completion.
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

    // Validate counterparty still exists (not soft-deleted) BEFORE create:
    // Prisma P2003 would surface as HTTP 500 instead of a friendly 404.
    const counterparty = await this.prisma.counterparty.findFirst({
      where: { id: original.counterpartyId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!counterparty)
      throw new NotFoundException('Контрагента було видалено — клонування неможливе');

    const number = await this.docNumbers.next(orgId, 'INVOICE');

    // Pre-compute VAT totals from original's lines so the cloned invoice ships consistent
    // totalWithoutVat/totalVat/totalWithVat; Prisma defaults leave them at 0 while
    // lines[].priceWithVat has real values. sumLineTotals — спільний single-pass суматор.
    const { totalWithoutVat, totalVat, totalWithVat } = sumLineTotals(original.lines);

    // Clone must NOT inherit workOrderId: the same WO would accumulate duplicate invoices
    // and the WO→Invoice 1:1 invariant breaks (auto-invoice on completion creates a 3rd).
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
    const priceWithoutVat = roundMoney(dto.quantity * dto.unitPrice);
    const vatAmount = roundMoney(priceWithoutVat * (vatRate / 100));
    const priceWithVat = roundMoney(priceWithoutVat + vatAmount);

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
      // good include required for unitShortName/coefficient in response.
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
    const priceWithoutVat = roundMoney(quantity * unitPrice);
    const vatAmount = roundMoney(priceWithoutVat * (vatRate / 100));
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
      // good include required for unitShortName/coefficient in response.
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
    // `inv` потрібен повним для status check; `existing` — лише для NotFoundException.
    const [inv, existing] = await Promise.all([
      this.prisma.invoice.findFirst({
        where: { id: invoiceId, orgId, deletedAt: null },
        select: { status: true },
      }),
      this.prisma.invoiceLine.findFirst({
        where: { id: lineId, invoiceId, orgId },
        select: { id: true },
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
    // sto-optimize: Postgres aggregate замість JS reduce 3× по N рядків.
    // Раніше: findMany(take:1000) тягнув всі invoiceLine рядки + 3× JS reduce.
    // Тепер: prisma.aggregate({_sum: ...}) — 1 row response, Postgres counts.
    // Паралель з паттерном work-orders.recalcTotals (2026-05-31).
    // InvoiceLine uses hard delete (no deletedAt column) — where matches original findMany.
    const result = await this.prisma.invoiceLine.aggregate({
      where: { invoiceId, orgId },
      _sum: { priceWithoutVat: true, vatAmount: true, priceWithVat: true },
    });
    const totalWithoutVat = roundMoney(Number(result._sum.priceWithoutVat ?? 0));
    const totalVat = roundMoney(Number(result._sum.vatAmount ?? 0));
    const totalWithVat = roundMoney(Number(result._sum.priceWithVat ?? 0));

    await this.prisma.invoice.update({
      where: { id: invoiceId, orgId },
      data: { totalWithoutVat, totalVat, totalWithVat, amount: totalWithVat },
    });
  }

  async findByWorkOrder(
    orgId: string,
    workOrderId: string,
  ): Promise<{
    id: string;
    number: string;
    status: InvoiceStatus;
    amount: number;
    documentDate: string | null;
  } | null> {
    const inv = await this.prisma.invoice.findFirst({
      where: { workOrderId, orgId, deletedAt: null, status: { not: InvoiceStatus.CANCELLED } },
      select: { id: true, number: true, status: true, amount: true, documentDate: true },
    });
    if (!inv) return null;
    return {
      id: inv.id,
      number: inv.number,
      status: inv.status,
      amount: Number(inv.amount),
      documentDate: inv.documentDate ? inv.documentDate.toISOString() : null,
    };
  }

  async refreshFromWorkOrder(orgId: string, workOrderId: string): Promise<InvoiceResponseDto> {
    // Narrow pre-check outside tx: fast 4xx for missing WO / wrong status / no active invoice.
    // Lines+parts are fetched inside the tx to close the TOCTOU window between reading
    // WO contents and writing invoice lines (a concurrent addLine/removePart would otherwise
    // be silently missed).
    const [woPre, existing] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { id: workOrderId, orgId, deletedAt: null },
        select: { id: true, status: true },
      }),
      this.prisma.invoice.findFirst({
        where: { workOrderId, orgId, deletedAt: null, status: { not: InvoiceStatus.CANCELLED } },
        select: { id: true, status: true },
      }),
    ]);
    if (!woPre) throw new NotFoundException('Наряд не знайдено');
    if (!INVOICEABLE_STATUSES.includes(woPre.status))
      throw new BadRequestException('Рахунок можна виставити лише для завершеного наряду');
    if (!existing) throw new NotFoundException('Активний рахунок не знайдено');
    // Guard: refreshFromWorkOrder must not overwrite SENT/PAID/OVERDUE lines — breaks bookkeeping.
    if (existing.status !== InvoiceStatus.DRAFT)
      throw new BadRequestException(
        'Оновити можна лише чернетку рахунку. Скасуйте поточний і виставте новий.',
      );

    // vatRate=0 corrupts VAT accounting — default 20 matches addLine (dto.vatRate ?? 20).
    const DEFAULT_VAT = 20;

    // WO lines+parts fetched inside tx to close TOCTOU between pre-check (reads WO contents)
    // and createMany (writes invoice lines). ReadCommitted allows concurrent addLine/refreshFromWorkOrder
    // to silently merge stale state. Serializable + inner re-check status — Postgres SSI catches
    // write-conflict → P2034 → 4xx instead of silent override.
    try {
      await this.prisma.$transaction(
        async tx => {
          const [invInTx, wo] = await Promise.all([
            tx.invoice.findFirst({
              where: { id: existing.id, orgId, deletedAt: null },
              select: { status: true },
            }),
            tx.workOrder.findFirst({
              where: { id: workOrderId, orgId, deletedAt: null },
              include: {
                lines: {
                  where: { deletedAt: null },
                  include: { work: { select: { name: true } } },
                },
                parts: {
                  where: { deletedAt: null },
                  include: { good: { select: { name: true } } },
                },
              },
            }),
          ]);
          if (!invInTx) throw new NotFoundException('Активний рахунок не знайдено');
          if (invInTx.status !== InvoiceStatus.DRAFT)
            throw new BadRequestException(
              'Оновити можна лише чернетку рахунку. Скасуйте поточний і виставте новий.',
            );
          if (!wo) throw new NotFoundException('Наряд не знайдено');

          await tx.invoiceLine.deleteMany({
            where: { invoiceId: existing.id, orgId },
          });

          const lineData = [
            ...wo.lines.map((l, i) => {
              // quantity = actualHours ?? normoHours: раніше `l.normoHours * price` не враховувало
              // actualHours → invoice.amount розходилась з WO.totalAmount (totalActualLabor).
              const quantity = l.actualHours ?? l.normoHours;
              const unitPrice = Number(l.price);
              const priceWithoutVat = roundMoney(quantity * unitPrice);
              const vatAmount = roundMoney(priceWithoutVat * (DEFAULT_VAT / 100));
              const priceWithVat = priceWithoutVat + vatAmount;
              return {
                orgId,
                invoiceId: existing.id,
                workId: l.workId,
                description: l.work?.name ?? 'Робота',
                quantity,
                unitPrice,
                vatRate: DEFAULT_VAT,
                priceWithoutVat,
                vatAmount,
                priceWithVat,
                sortOrder: i,
              };
            }),
            ...wo.parts.map((p, i) => {
              const priceWithoutVat = roundMoney(Number(p.quantity) * Number(p.price));
              const vatAmount = roundMoney(priceWithoutVat * (DEFAULT_VAT / 100));
              const priceWithVat = priceWithoutVat + vatAmount;
              return {
                orgId,
                invoiceId: existing.id,
                goodId: p.goodId,
                description: p.good?.name ?? 'Запчастина',
                quantity: Number(p.quantity),
                unitPrice: Number(p.price),
                vatRate: DEFAULT_VAT,
                priceWithoutVat,
                vatAmount,
                priceWithVat,
                sortOrder: wo.lines.length + i,
              };
            }),
          ];

          if (lineData.length > 0) {
            await tx.invoiceLine.createMany({ data: lineData });
          }

          const { totalWithoutVat, totalVat, totalWithVat } = sumLineTotals(lineData);
          await tx.invoice.update({
            where: { id: existing.id, orgId },
            data: { totalWithoutVat, totalVat, totalWithVat, amount: totalWithVat },
          });
        },
        { isolationLevel: 'Serializable', timeout: 10_000 },
      );
    } catch (err) {
      throwIfSerializationConflict(
        err,
        'Інший користувач щойно оновив цей рахунок. Оновіть сторінку та повторіть.',
      );
    }

    return this.findOne(orgId, existing.id);
  }

  async remove(orgId: string, id: string): Promise<void> {
    // Narrow tenant guard — потрібен лише `status` для business-check.
    const inv = await this.prisma.invoice.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true },
    });
    if (!inv) throw new NotFoundException('Рахунок не знайдено');
    if (inv.status !== InvoiceStatus.DRAFT)
      throw new BadRequestException('Видалити можна лише чернетку');
    // Race-safe: updateMany з повним compound where (id+orgId+deletedAt:null)
    // блокує double-delete race.
    await this.prisma.invoice.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
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
      documentDate?: Date | null;
      createdAt: Date;
      updatedAt: Date;
      deletedAt?: Date | null;
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
      dueDate: inv.dueDate instanceof Date ? inv.dueDate.toISOString() : (inv.dueDate ?? null),
      documentDate: inv.documentDate ? inv.documentDate.toISOString().slice(0, 10) : null,
      ...(paidAmount !== undefined ? { paidAmount } : {}),
      ...(includeLines && inv.lines ? { lines: inv.lines.map(l => this.toLineDto(l)) } : {}),
      createdAt: inv.createdAt instanceof Date ? inv.createdAt.toISOString() : inv.createdAt,
      updatedAt: inv.updatedAt instanceof Date ? inv.updatedAt.toISOString() : inv.updatedAt,
      deletedAt:
        inv.deletedAt instanceof Date ? inv.deletedAt.toISOString() : (inv.deletedAt ?? null),
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
    // `companyName ?? [...].join(' ') ?? ''` had dead `?? ''` (join always returns string),
    // and failed when companyName='' (non-nullish → never reached lastName/firstName).
    // formatPersonName(...) || '' correctly handles companyName=null/undefined/''.
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
      // safeCoeff() catches legacy/seed coefficient=0 — frontend uses it as divisor for display↔base conversion.
      coefficient: safeCoeff(selectedUoM?.coefficient ?? baseUoM?.coefficient),
      quantity: l.quantity,
      unitPrice: Number(l.unitPrice),
      vatRate: Number(l.vatRate),
      priceWithoutVat: Number(l.priceWithoutVat),
      vatAmount: Number(l.vatAmount),
      priceWithVat: Number(l.priceWithVat),
      sortOrder: l.sortOrder,
      createdAt: l.createdAt instanceof Date ? l.createdAt.toISOString() : l.createdAt,
    };
  }
}
