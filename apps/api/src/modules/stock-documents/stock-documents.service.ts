import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { DocumentType, Prisma, StockDocumentType, StockMovementType } from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS } from '@sto/shared';

import { kyivToday } from '../../common/utils/kyiv-date';
import { calculatePagination, buildSortOrderBy } from '../../common/utils/pagination';
import { assertFsmTransition } from '../../common/utils/fsm';
import { safeCoeff } from '../../common/utils/math';
import { uniqueDefinedIds, initCountsMap } from '../../common/utils/linked-counts';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { DocumentNumberService } from '../document-number/document-number.service';
import {
  CreateStockDocumentDto,
  UpdateStockDocumentDto,
  StockDocumentResponseDto,
  PaginatedStockDocumentsDto,
} from './stock-documents.dto';

const DOC_STATUSES = ['DRAFT', 'CONFIRMED', 'CANCELLED'] as const;
type DocStatus = (typeof DOC_STATUSES)[number];

const DOC_TRANSITIONS: Record<DocStatus, DocStatus[]> = {
  DRAFT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: [],
  CANCELLED: [],
};

const MOVEMENT_TYPES: Partial<Record<StockDocumentType, StockMovementType>> = {
  WRITEOFF: StockMovementType.WRITEOFF,
  OPENING_BALANCE: StockMovementType.OPENING_BALANCE,
  RECEIPT: StockMovementType.RECEIPT,
};

// sto-optimize (cycle 3/3): sort-field whitelist hoisted from findAll body — static string-map,
// re-allocated on every list request under polling. Sibling to SP_SORT_FIELDS/INV_SORT_FIELDS/WO_SORT/PO_SORT.
const SD_SORT_FIELDS: Record<string, string> = {
  documentDate: 'documentDate',
  createdAt: 'createdAt',
};

@Injectable()
export class StockDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly docNumbers: DocumentNumberService,
  ) {}

  async findAll(
    orgId: string,
    page = 1,
    limit = 20,
    type?: string,
    status?: string,
    showDeleted = false,
    dateFrom?: string,
    dateTo?: string,
    sortBy?: string,
    sortDir?: 'asc' | 'desc',
  ): Promise<PaginatedStockDocumentsDto> {
    const where: Prisma.StockDocumentWhereInput = {
      orgId,
      deletedAt: showDeleted ? undefined : null,
    };
    if (type) where.type = type as StockDocumentType;
    if (status) where.status = status as DocStatus;
    if (dateFrom || dateTo) {
      where.documentDate = {
        ...(dateFrom ? { gte: new Date(dateFrom) } : {}),
        ...(dateTo ? { lte: new Date(dateTo + 'T23:59:59.999Z') } : {}),
      };
    }

    const { skip, take } = calculatePagination({ page, limit });
    const orderBy = buildSortOrderBy(SD_SORT_FIELDS, sortBy, sortDir);
    // Bug review (sto-optimize 2026-06-05): lines не використовуються у table-cells списку,
    // лише `doc.lines.length` у комірці «Позицій». DetailPanel рендериться для ОДНОГО
    // вибраного doc і завантажується lazily через GET /stock-documents/:id (findOne уже
    // включає lines з full include). Винесли `lines` з findAll → economy: 1000 × 20 = 20K
    // line rows на запит → 0; кількість віддаємо через `_count.lines`. linesCount → toDto.
    const [items, total] = await Promise.all([
      this.prisma.stockDocument.findMany({
        where,
        skip,
        take,
        orderBy,
        include: {
          branch: { select: { name: true } },
          warehouse: { select: { name: true } },
          targetWarehouse: { select: { name: true } },
          purchaseOrder: { select: { number: true } },
          _count: { select: { lines: { where: { deletedAt: null } } } },
        },
      }),
      this.prisma.stockDocument.count({ where }),
    ]);

    return { items: items.map(d => this.toDto(d)), total, page, limit: take };
  }

  async findOne(orgId: string, id: string): Promise<StockDocumentResponseDto> {
    const doc = await this.prisma.stockDocument.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        branch: { select: { name: true } },
        warehouse: { select: { name: true } },
        targetWarehouse: { select: { name: true } },
        purchaseOrder: { select: { number: true } },
        lines: {
          where: { deletedAt: null },
          take: 1000,
          include: {
            good: {
              select: {
                name: true,
                sku: true,
                unit: true,
                unitOfMeasure: { select: { shortName: true, coefficient: true } },
              },
            },
          },
        },
      },
    });
    if (!doc) throw new NotFoundException('Документ не знайдено');
    return this.toDto(doc);
  }

  async create(orgId: string, dto: CreateStockDocumentDto): Promise<StockDocumentResponseDto> {
    // Усі 3 FK перевірки можуть йти конкурентно — кожна незалежна.
    // Conditional target warehouse: tернарка зберігає типи й уникає зайвого RTT для TRANSFER.
    // sto-optimize: narrow projection — FK guards використовуються лише для існування 404,
    // решта полів (name/address/syncVersion/etc.) не читаються далі.
    const [branch, warehouse, target, purchaseOrder] = await Promise.all([
      this.prisma.garageBranch.findFirst({
        where: { id: dto.branchId, orgId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.warehouse.findFirst({
        where: { id: dto.warehouseId, orgId, deletedAt: null },
        select: { id: true },
      }),
      dto.targetWarehouseId
        ? this.prisma.warehouse.findFirst({
            where: { id: dto.targetWarehouseId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      // Опціональний FK-guard для замовлення-джерела: коли передано purchaseOrderId,
      // воно має існувати у цій org (soft-delete aware). Пропускається якщо undefined.
      dto.purchaseOrderId
        ? this.prisma.purchaseOrder.findFirst({
            where: { id: dto.purchaseOrderId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    if (!branch) throw new NotFoundException('Філію не знайдено');
    if (!warehouse) throw new NotFoundException('Склад не знайдено');
    if (dto.purchaseOrderId && !purchaseOrder) {
      throw new BadRequestException('Замовлення не знайдено');
    }

    if (dto.type === 'TRANSFER' && !dto.targetWarehouseId) {
      throw new BadRequestException('Для переміщення потрібен склад призначення');
    }
    if (dto.targetWarehouseId) {
      if (!target) throw new NotFoundException('Склад призначення не знайдено');
      if (dto.targetWarehouseId === dto.warehouseId) {
        throw new BadRequestException('Склад джерела і призначення не можуть збігатись');
      }
    }

    const docTypeMap: Record<string, DocumentType> = {
      WRITEOFF: 'STOCK_WRITEOFF',
      TRANSFER: 'STOCK_TRANSFER',
      OPENING_BALANCE: 'STOCK_OPENING',
      RECEIPT: 'STOCK_RECEIPT',
    };
    const number = await this.docNumbers.next(orgId, docTypeMap[dto.type] ?? 'STOCK_WRITEOFF');

    const lines = dto.lines ?? [];

    const doc = await this.prisma.$transaction(
      async tx => {
        const created = await tx.stockDocument.create({
          data: {
            orgId,
            branchId: dto.branchId,
            warehouseId: dto.warehouseId,
            targetWarehouseId: dto.targetWarehouseId ?? null,
            purchaseOrderId: dto.purchaseOrderId ?? null,
            type: dto.type,
            number,
            notes: dto.notes,
            documentDate: dto.documentDate ? new Date(dto.documentDate) : kyivToday(),
          },
        });
        if (lines.length) {
          await tx.stockDocumentLine.createMany({
            data: lines.map(l => ({
              orgId,
              stockDocumentId: created.id,
              goodId: l.goodId,
              quantity: l.quantity,
              price: l.price ?? null,
            })),
          });
        }
        return tx.stockDocument.findFirstOrThrow({
          where: { id: created.id, orgId, deletedAt: null },
          include: {
            branch: { select: { name: true } },
            warehouse: { select: { name: true } },
            targetWarehouse: { select: { name: true } },
            purchaseOrder: { select: { number: true } },
            lines: {
              where: { deletedAt: null },
              take: 1000,
              include: {
                good: {
                  select: {
                    name: true,
                    sku: true,
                    unit: true,
                    unitOfMeasure: { select: { shortName: true, coefficient: true } },
                  },
                },
              },
            },
          },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // explicit timeout: create + createMany in one tx, can exceed Prisma default 30s on large batches

    return this.toDto(doc);
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateStockDocumentDto,
  ): Promise<StockDocumentResponseDto> {
    // sto-optimize: status-only projection — guard потребує лише DRAFT перевірку.
    // Раніше тягнуло warehouseId/branchId/notes/documentDate/syncVersion + всі ігноровані колонки.
    const doc = await this.prisma.stockDocument.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true },
    });
    if (!doc) throw new NotFoundException('Документ не знайдено');
    if (doc.status !== 'DRAFT') throw new BadRequestException('Редагувати можна лише чернетку');

    const updated = await this.prisma.$transaction(
      async tx => {
        if (dto.lines !== undefined) {
          await tx.stockDocumentLine.updateMany({
            where: { stockDocumentId: id, orgId },
            data: { deletedAt: new Date() },
          });
          if (dto.lines.length) {
            await tx.stockDocumentLine.createMany({
              data: dto.lines.map(l => ({
                orgId,
                stockDocumentId: id,
                goodId: l.goodId,
                quantity: l.quantity,
                price: l.price ?? null,
              })),
            });
          }
        }
        return tx.stockDocument.update({
          where: { id, orgId },
          data: {
            notes: dto.notes,
            documentDate: dto.documentDate ? new Date(dto.documentDate) : undefined,
          },
          include: {
            branch: { select: { name: true } },
            warehouse: { select: { name: true } },
            targetWarehouse: { select: { name: true } },
            purchaseOrder: { select: { number: true } },
            lines: {
              where: { deletedAt: null },
              take: 1000,
              include: {
                good: {
                  select: {
                    name: true,
                    sku: true,
                    unit: true,
                    unitOfMeasure: { select: { shortName: true, coefficient: true } },
                  },
                },
              },
            },
          },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    ); // explicit timeout: soft-delete lines + createMany in one tx

    return this.toDto(updated);
  }

  async transition(
    orgId: string,
    id: string,
    newStatus: DocStatus,
    userId?: string,
  ): Promise<StockDocumentResponseDto> {
    const doc = await this.prisma.stockDocument.findFirst({
      where: { id, orgId, deletedAt: null },
      include: {
        lines: {
          where: { deletedAt: null },
          take: 1000,
          include: { good: { select: { unitId: true } } },
        },
      },
    });
    if (!doc) throw new NotFoundException('Документ не знайдено');

    assertFsmTransition(DOC_TRANSITIONS, doc.status as DocStatus, newStatus);

    if (newStatus === 'CONFIRMED') {
      if (!doc.lines.length) {
        throw new BadRequestException('Документ не може бути підтверджено без позицій');
      }

      await this.prisma.$transaction(
        async tx => {
          // Ідемпотентність CONFIRM (анти-race/анти-retry): FSM-перевірка вище (рядок 309)
          // читає STALE pre-tx статус. Без in-tx гейту два concurrent CONFIRM (double-click,
          // повтор запиту після таймауту) обидва пройшли б FSM-check → ПОДВІЙНИЙ рух складу
          // (подвійний WRITEOFF/RECEIPT/TRANSFER, залишки ×2). CAS `updateMany where status:DRAFT`
          // ПЕРШИМ у tx: лише перший запит отримує count=1 (DRAFT→CONFIRMED атомарно row-locked),
          // другий бачить count=0 → throw → rollback усіх side-effects. Дзеркалить
          // supplier-payments.confirm CAS (FIN-C1) + work-orders.transition in-tx re-read (Хвиля 1).
          const cas = await tx.stockDocument.updateMany({
            where: { id, orgId, deletedAt: null, status: 'DRAFT' },
            data: { status: 'CONFIRMED', confirmedAt: new Date(), confirmedBy: userId ?? null },
          });
          if (cas.count === 0) {
            throw new BadRequestException('Статус документу змінився — повторіть дію');
          }

          const movType = MOVEMENT_TYPES[doc.type];
          if (doc.type !== 'TRANSFER' && !movType)
            throw new BadRequestException(`Непідтримуваний тип документу: ${doc.type}`);

          // sto-optimize: всі лінії незалежні (різні goodId/warehouseId rows) — паралелимо.
          // Всередині кожної лінії: createMovement і UoM-update пишуть у різні таблиці — теж
          // паралельно. Для TRANSFER: writeoff+receipt мають різні warehouseId → race-safe.
          // NB: усередині одного $transaction Prisma виконує DB-операції послідовно над
          // прикріпленим connection, тож Promise.all дає лише JS-рівневий overhead-economy
          // (не справжній паралелізм) — але це безпечно для race-конкуренції stockItem upsert
          // (Postgres serialize ON CONFLICT під тим самим connection).
          await Promise.all(
            doc.lines.map(async line => {
              const lineUnitId = line.good?.unitId ?? null;
              // persist resolved UoM — extracted to avoid duplication in both branches.
              // defense-in-depth: include orgId у where (узгоджено з PO.receive
              // де line update теж компаундний where: { id, orgId }).
              const maybeUpdateUom = lineUnitId
                ? tx.stockDocumentLine.update({
                    where: { id: line.id, orgId },
                    data: { unitOfMeasureId: lineUnitId },
                  })
                : Promise.resolve();
              // Shared movement fields — only warehouseId/type/quantity differ per branch.
              const baseArgs = {
                goodId: line.goodId,
                price: line.price ? Number(line.price) : undefined,
                documentType: 'StockDocument' as const,
                documentId: id,
                createdBy: userId,
                unitOfMeasureId: lineUnitId,
              };
              if (doc.type === 'TRANSFER') {
                // ПОСЛІДОВНО (не Promise.all): спершу writeoff зі складу-джерела списує партії
                // FIFO і повертає собівартість; цільова партія створюється з ЦІЄЮ собівартістю
                // (перенос cost, не ціна продажу). Fallback baseArgs.price якщо консюм порожній.
                const src = await this.inventory.createMovement(
                  orgId,
                  {
                    ...baseArgs,
                    warehouseId: doc.warehouseId,
                    type: 'WRITEOFF',
                    quantity: -line.quantity,
                  },
                  tx,
                );
                await this.inventory.createMovement(
                  orgId,
                  {
                    ...baseArgs,
                    warehouseId: doc.targetWarehouseId!,
                    type: 'RECEIPT',
                    quantity: line.quantity,
                    price: src.weightedCostPrice ?? baseArgs.price,
                  },
                  tx,
                );
                return maybeUpdateUom;
              }
              const quantity = doc.type === 'WRITEOFF' ? -line.quantity : line.quantity;
              return Promise.all([
                this.inventory.createMovement(
                  orgId,
                  { ...baseArgs, warehouseId: doc.warehouseId, type: movType!, quantity },
                  tx,
                ),
                maybeUpdateUom,
              ]);
            }),
          );

          // Статус вже переведено CAS-ом на початку tx (DRAFT→CONFIRMED). Повторний update не
          // потрібен — рухи складу вище виконались у тій самій tx після успішного CAS-гейту.
        },
        { timeout: 15_000 },
      ); // explicit 15s timeout: N rows × createMovement (StockMovement + upsert stockItem); exceeds Prisma default at ~50+ lines
    } else {
      await this.prisma.stockDocument.update({ where: { id, orgId }, data: { status: newStatus } });
    }

    return this.findOne(orgId, id);
  }

  async remove(orgId: string, id: string): Promise<void> {
    // Narrow tenant guard — потрібен лише `status` для DRAFT check.
    const doc = await this.prisma.stockDocument.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { status: true },
    });
    if (!doc) throw new NotFoundException('Документ не знайдено');
    if (doc.status !== 'DRAFT') throw new BadRequestException('Видалити можна лише чернетку');
    // Race-safe updateMany з повним compound where (id+orgId+deletedAt:null).
    await this.prisma.stockDocument.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  // ─── Пов'язані документи ─────────────────────────────────────────────────
  // Документи, пов'язані зі складським документом: замовлення-джерело (RECEIPT/OPENING)
  // + склади (джерело + призначення для TRANSFER). Дзеркалить Counterparty/Invoice-патерн
  // (orgId + deletedAt:null, Decimal→Number, zero-init counts — Bug #641 lesson: count == detail).

  async getLinkedDocuments(orgId: string, id: string) {
    const doc = await this.prisma.stockDocument.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { purchaseOrderId: true, warehouseId: true, targetWarehouseId: true },
    });
    if (!doc) {
      return { purchaseOrder: [], warehouses: [] };
    }

    const [purchaseOrder, sourceWarehouse, targetWarehouse] = await Promise.all([
      doc.purchaseOrderId
        ? this.prisma.purchaseOrder.findFirst({
            where: { id: doc.purchaseOrderId, orgId, deletedAt: null },
            select: { id: true, number: true, status: true, totalAmount: true },
          })
        : Promise.resolve(null),
      this.prisma.warehouse.findFirst({
        where: { id: doc.warehouseId, orgId, deletedAt: null },
        select: { id: true, name: true },
      }),
      doc.targetWarehouseId
        ? this.prisma.warehouse.findFirst({
            where: { id: doc.targetWarehouseId, orgId, deletedAt: null },
            select: { id: true, name: true },
          })
        : Promise.resolve(null),
    ]);

    return {
      purchaseOrder: purchaseOrder
        ? [{ ...purchaseOrder, totalAmount: Number(purchaseOrder.totalAmount) }]
        : [],
      warehouses: [
        ...(sourceWarehouse ? [sourceWarehouse] : []),
        ...(targetWarehouse ? [targetWarehouse] : []),
      ],
    };
  }

  async getLinkedCounts(
    orgId: string,
    ids: string[],
  ): Promise<Record<string, { purchaseOrder: number; warehouses: number }>> {
    if (ids.length === 0) return {};
    const result = initCountsMap(ids, ['purchaseOrder', 'warehouses'] as const);

    const docs = await this.prisma.stockDocument.findMany({
      where: { id: { in: ids }, orgId, deletedAt: null },
      select: { id: true, purchaseOrderId: true, warehouseId: true, targetWarehouseId: true },
    });

    // Bug #A/#641: count має відповідати detail (getLinkedDocuments фільтрує deletedAt:null).
    // Наявність FK ≠ наявність живого запису: PO/склад можна soft-delete-нути поки документ
    // на них посилається. Без liveness-перевірки badge показував би більше, ніж панель.
    const poIds = uniqueDefinedIds(docs.map(d => d.purchaseOrderId));
    const whIds = uniqueDefinedIds(docs.flatMap(d => [d.warehouseId, d.targetWarehouseId]));
    const [livePo, liveWh] = await Promise.all([
      poIds.length
        ? this.prisma.purchaseOrder.findMany({
            where: { id: { in: poIds }, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve([]),
      whIds.length
        ? this.prisma.warehouse.findMany({
            where: { id: { in: whIds }, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve([]),
    ]);
    const livePoSet = new Set(livePo.map(p => p.id));
    const liveWhSet = new Set(liveWh.map(w => w.id));

    for (const d of docs) {
      if (!result[d.id]) continue;
      result[d.id].purchaseOrder = d.purchaseOrderId && livePoSet.has(d.purchaseOrderId) ? 1 : 0;
      // Джерело + ціль (TRANSFER) — кожен рахується лише якщо живий (дзеркалить detail).
      const sourceLive = liveWhSet.has(d.warehouseId) ? 1 : 0;
      const targetLive = d.targetWarehouseId && liveWhSet.has(d.targetWarehouseId) ? 1 : 0;
      result[d.id].warehouses = sourceLive + targetLive;
    }

    return result;
  }

  private toDto(doc: {
    id: string;
    orgId: string;
    number: string;
    type: string;
    status: string;
    branchId: string;
    warehouseId: string;
    targetWarehouseId: string | null;
    purchaseOrderId?: string | null;
    notes: string | null;
    documentDate?: Date | null;
    confirmedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt?: Date | null;
    branch: { name: string } | null;
    warehouse: { name: string } | null;
    targetWarehouse: { name: string } | null;
    purchaseOrder?: { number: string } | null;
    // findAll → `_count.lines` тільки; findOne → повний `lines[]`. Обидва опціональні.
    lines?: Array<{
      id: string;
      goodId: string;
      quantity: number;
      price: Prisma.Decimal | null;
      unitOfMeasureId?: string | null;
      good: {
        name: string;
        sku: string | null;
        unit: string;
        unitOfMeasure: { shortName: string; coefficient: number } | null;
      } | null;
    }>;
    _count?: { lines: number };
  }): StockDocumentResponseDto {
    return {
      id: doc.id,
      orgId: doc.orgId,
      number: doc.number,
      type: doc.type,
      status: doc.status,
      branchId: doc.branchId,
      branchName: doc.branch?.name,
      warehouseId: doc.warehouseId,
      warehouseName: doc.warehouse?.name,
      targetWarehouseId: doc.targetWarehouseId ?? null,
      targetWarehouseName: doc.targetWarehouse?.name ?? null,
      purchaseOrderId: doc.purchaseOrderId ?? null,
      purchaseOrderNumber: doc.purchaseOrder?.number ?? null,
      notes: doc.notes ?? null,
      confirmedAt:
        doc.confirmedAt instanceof Date ? doc.confirmedAt.toISOString() : (doc.confirmedAt ?? null),
      documentDate: doc.documentDate ? doc.documentDate.toISOString().slice(0, 10) : null,
      lines: (doc.lines ?? []).map(l => ({
        id: l.id,
        goodId: l.goodId,
        goodName: l.good?.name,
        goodSku: l.good?.sku ?? null,
        unit: l.good?.unit,
        unitShortName: l.good?.unitOfMeasure?.shortName ?? l.good?.unit,
        // safeCoeff() guards against legacy/seed coefficient=0/NaN/negative —
        // frontend uses coefficient as divisor for display↔base conversion; 0 → Infinity → silent NaN.
        coefficient: safeCoeff(l.good?.unitOfMeasure?.coefficient),
        quantity: l.quantity,
        price: l.price != null ? Number(l.price) : null,
        unitOfMeasureId: l.unitOfMeasureId ?? null,
      })),
      // findAll: lines opted-out, beredemo з `_count`; findOne: lines присутні → fallback.
      linesCount: doc._count?.lines ?? doc.lines?.length ?? 0,
      createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt,
      updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : doc.updatedAt,
      deletedAt:
        doc.deletedAt instanceof Date ? doc.deletedAt.toISOString() : (doc.deletedAt ?? null),
    };
  }
}
