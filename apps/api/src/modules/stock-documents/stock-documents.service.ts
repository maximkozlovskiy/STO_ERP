import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import {
  DocumentType,
  Prisma,
  StockDocumentStatus,
  StockDocumentType,
  StockMovementType,
} from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS, translateError } from '@sto/shared';

import { getLocale } from '../../common/tenant/tenant-context';
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

type DocStatus = 'DRAFT' | 'CONFIRMED' | 'CANCELLED';

export const DOC_TRANSITIONS: Record<DocStatus, DocStatus[]> = {
  DRAFT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: [],
  CANCELLED: [],
};

const MOVEMENT_TYPES: Partial<Record<StockDocumentType, StockMovementType>> = {
  WRITEOFF: StockMovementType.WRITEOFF,
  OPENING_BALANCE: StockMovementType.OPENING_BALANCE,
  RECEIPT: StockMovementType.RECEIPT,
};

/**
 * BR-SDOC-008 (Bug #801): бюджет транзакції проведення росте з кількістю рядків.
 *
 * Рядки проводяться послідовно (BR-SDOC-004), кожен — кілька запитів у createMovement, а TRANSFER
 * робить два рухи на рядок. Заміряно на dev-БД 2026-10-08 (127.0.0.1): TRANSFER ≈ 28 мс/рядок на
 * чистому товарі й більше, коли в товару накопичились партії. Фіксовані 15 с документ на 500 рядків
 * (стільки пропускає DTO) проходив із запасом 5% (14,3 с), а вдруге на тих самих товарах падав:
 * 500 «Внутрішня помилка сервера» через 15,1 с, усі рухи відкочено. 120 мс/рядок — це ×4 від
 * заміряного: 500 рядків → 60 с. Малі документи лишаються на 15 с.
 */
export const CONFIRM_TX_BASE_TIMEOUT_MS = 15_000;
export const CONFIRM_TX_PER_LINE_MS = 120;
export function confirmTxTimeoutMs(lineCount: number): number {
  return Math.max(CONFIRM_TX_BASE_TIMEOUT_MS, lineCount * CONFIRM_TX_PER_LINE_MS);
}

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
    q?: string,
  ): Promise<PaginatedStockDocumentsDto> {
    const where: Prisma.StockDocumentWhereInput = {
      orgId,
      deletedAt: showDeleted ? undefined : null,
    };
    if (type) where.type = type as StockDocumentType;
    if (status) where.status = status as DocStatus;
    // Пошук — за номером документа або приміткою; orgId лишається на верхньому рівні where.
    const search = q?.trim();
    if (search) {
      where.OR = [
        { number: { contains: search, mode: 'insensitive' } },
        { notes: { contains: search, mode: 'insensitive' } },
      ];
    }
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
    if (!doc)
      throw new NotFoundException(translateError('err.stockDocument.notFound', getLocale()));
    return this.toDto(doc);
  }

  /**
   * Tenant-guard: усі goodId рядків мусять належати org (Good.id глобально унікальний → інакше
   * cross-tenant FK-injection на confirm→createMovement). Кидає 404 ДО будь-якого запису.
   */
  private async validateLineGoodIds(
    orgId: string,
    lines: Array<{ goodId: string }>,
  ): Promise<void> {
    if (!lines.length) return;
    const goodIds = Array.from(new Set(lines.map(l => l.goodId)));
    const goods = await this.prisma.good.findMany({
      where: { id: { in: goodIds }, orgId, deletedAt: null },
      select: { id: true },
    });
    if (goods.length !== goodIds.length) {
      const found = new Set(goods.map(g => g.id));
      const missing = goodIds.find(gid => !found.has(gid));
      throw new NotFoundException(
        translateError('err.stockDocument.goodNotFound', getLocale(), { missing: String(missing) }),
      );
    }
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
    if (!branch)
      throw new NotFoundException(translateError('err.stockDocument.branchNotFound', getLocale()));
    if (!warehouse)
      throw new NotFoundException(
        translateError('err.stockDocument.warehouseNotFound', getLocale()),
      );
    if (dto.purchaseOrderId && !purchaseOrder) {
      throw new BadRequestException(translateError('err.stockDocument.orderNotFound', getLocale()));
    }

    if (dto.type === 'TRANSFER' && !dto.targetWarehouseId) {
      throw new BadRequestException(
        translateError('err.stockDocument.transferTargetRequired', getLocale()),
      );
    }
    if (dto.targetWarehouseId) {
      if (!target)
        throw new NotFoundException(
          translateError('err.stockDocument.targetWarehouseNotFound', getLocale()),
        );
      if (dto.targetWarehouseId === dto.warehouseId) {
        throw new BadRequestException(
          translateError('err.stockDocument.sourceTargetSame', getLocale()),
        );
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
    // Tenant-guard goodId рядків (pre-prod audit): Good.id глобально унікальний → без цього
    // org A підсунув би goodId org B → на confirm createMovement пише рух проти чужого товару.
    await this.validateLineGoodIds(orgId, lines);

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
    if (!doc)
      throw new NotFoundException(translateError('err.stockDocument.notFound', getLocale()));
    if (doc.status !== 'DRAFT')
      throw new BadRequestException(
        translateError('err.stockDocument.onlyDraftEditable', getLocale()),
      );
    // Tenant-guard goodId рядків (pre-prod audit) — див. коментар у create().
    if (dto.lines) await this.validateLineGoodIds(orgId, dto.lines);

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
    if (!doc)
      throw new NotFoundException(translateError('err.stockDocument.notFound', getLocale()));

    assertFsmTransition(DOC_TRANSITIONS, doc.status, newStatus);

    if (newStatus === 'CONFIRMED') {
      if (!doc.lines.length) {
        throw new BadRequestException(
          translateError('err.stockDocument.confirmRequiresLines', getLocale()),
        );
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
            throw new BadRequestException(
              translateError('err.stockDocument.statusChanged', getLocale()),
            );
          }

          const movType = MOVEMENT_TYPES[doc.type];
          if (doc.type !== 'TRANSFER' && !movType)
            throw new BadRequestException(
              translateError('err.stockDocument.unsupportedType', getLocale(), { type: doc.type }),
            );

          // BR-SDOC-003/004: рядки проводяться ПОСЛІДОВНО. Один товар може стояти в документі
          // кількома рядками (різні партії з різною ціною — це дозволено), а такі рядки ділять
          // один StockItem і ті самі партії FIFO: createMovement читає залишок і партії, потім
          // пише, тож два рухи одного товару, запущені через Promise.all, перемежовувались би
          // на await-ах. Раніше тут стояв Promise.all із коментарем «усі лінії мають різні
          // goodId» — код цього ніколи не гарантував. Виграшу паралельність не давала: у межах
          // однієї транзакції Prisma однаково виконує запити по черзі. Той самий підхід, що для
          // запчастин наряду (BR-WO-003).
          const applyLine = async (line: (typeof doc.lines)[number]): Promise<unknown> => {
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
          };
          for (const line of doc.lines) {
            await applyLine(line);
          }

          // Статус вже переведено CAS-ом на початку tx (DRAFT→CONFIRMED). Повторний update не
          // потрібен — рухи складу вище виконались у тій самій tx після успішного CAS-гейту.
        },
        // BR-SDOC-008: не фіксовані 15 с — бюджет залежить від кількості рядків (Bug #801).
        { timeout: confirmTxTimeoutMs(doc.lines.length) },
      );
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
    if (!doc)
      throw new NotFoundException(translateError('err.stockDocument.notFound', getLocale()));
    if (doc.status !== 'DRAFT')
      throw new BadRequestException(
        translateError('err.stockDocument.onlyDraftDeletable', getLocale()),
      );
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
    // Prisma віддає enum-значення; руками звужений `string` тут лише ховав тип
    // від DTO. Усі 4 виклики toDto передають рядок Prisma → звуження безпечне.
    type: StockDocumentType;
    status: StockDocumentStatus;
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
        // coefficient — множник display↔base (qty_base = qty * coefficient); safeCoeff guard 0→1.
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
