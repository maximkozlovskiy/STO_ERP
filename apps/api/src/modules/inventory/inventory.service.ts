import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { Prisma, StockMovementType, BatchCostMethod } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BatchService, BatchConsumeResult } from './batch.service';
import { SettingsService } from '../settings/settings.service';
import { kyivOffsetMs } from '../../common/utils/kyiv-date';

const DOC_TYPE_LABELS: Record<string, string> = {
  PurchaseOrder: 'Замовлення',
  WorkOrder: 'Наряд',
  StockDocument: 'Документ',
  Invoice: 'Рахунок',
  SupplierReturn: 'Повернення постачальнику',
};

export interface CreateMovementDto {
  goodId: string;
  warehouseId: string;
  type: StockMovementType;
  quantity: number; // positive = in, negative = out
  price?: number;
  documentType?: string;
  documentId?: string;
  documentLineId?: string;
  notes?: string;
  createdBy?: string;
  // Batch fields (optional, used when type=RECEIPT)
  purchaseOrderLineId?: string;
  batchNumber?: string;
  expiryDate?: Date;
  unitOfMeasureId?: string | null;
}

/**
 * Результат руху залишків. Для розходу (quantity<0, не reservation) містить списані партії
 * та зважену собівартість (COGS) — викликач (наряд) фіксує її у WorkOrderPart.batchCostPrice.
 */
export interface CreateMovementResult {
  movementId: string;
  consumed: BatchConsumeResult[];
  weightedCostPrice: number | null;
}

/** Зважена собівартість (COGS) зі списаних партій: Σ(qty×costPrice)/Σqty; null якщо нічого. */
function weightedFromConsumed(consumed: BatchConsumeResult[]): number | null {
  const totalQty = consumed.reduce((s, c) => s + c.quantity, 0);
  if (totalQty <= 0) return null;
  const totalCost = consumed.reduce((s, c) => s + c.quantity * c.costPrice, 0);
  return totalCost / totalQty;
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => BatchService)) private readonly batchService: BatchService,
    private readonly settingsService: SettingsService,
  ) {}

  async createMovement(
    orgId: string,
    dto: CreateMovementDto,
    tx?: Prisma.TransactionClient,
  ): Promise<CreateMovementResult> {
    if (dto.quantity === 0) throw new BadRequestException('Кількість не може бути нульовою');
    if (!Number.isFinite(dto.quantity)) {
      throw new BadRequestException('Невірне значення кількості');
    }
    if (dto.price !== undefined && dto.price !== null && !Number.isFinite(dto.price)) {
      throw new BadRequestException('Невірне значення ціни');
    }
    if (dto.type === 'RESERVATION_RELEASE' && dto.quantity > 0) {
      throw new BadRequestException("Зняття резерву: кількість повинна бути від'ємною");
    }

    // Атомарність: createMovement робить кілька залежних записів (StockMovement +
    // StockBatch/consumeBatch + StockItem upsert + BatchConsumption). Якщо викликач не
    // передав tx — самообгортаємось у $transaction, інакше throw (race-guard/нестача)
    // лишив би частину записів без rollback (напр. orphan BatchConsumption). Усі поточні
    // прод-викликачі передають tx; це backstop для майбутніх/службових викликів.
    if (!tx) {
      return this.prisma.$transaction(innerTx => this.createMovement(orgId, dto, innerTx), {
        timeout: 15_000,
      });
    }
    const db = tx;

    // RECEIPT with quantity > 0 always creates a StockBatch. If price is absent (typical for
    // TRANSFER or inventory-receipt), fall back to good.purchasePrice, otherwise 0 (free samples).
    // This preserves batch-tracking without blocking legitimate business operations.
    //
    // Validate tenant boundary for caller-supplied UoM: InventoryService is a public API surface —
    // future callers (work-orders, mobile sync, manual adjustments) could leak cross-tenant linkage.
    // FK alone enforces only global existence, not orgId.
    const needsCostLookup =
      dto.type === 'RECEIPT' && dto.quantity > 0 && (dto.price === undefined || dto.price === null);
    const needsUomGuard = !!dto.unitOfMeasureId;
    const [goodForCost, uom] = await Promise.all([
      needsCostLookup
        ? db.good.findFirst({
            where: { id: dto.goodId, orgId, deletedAt: null },
            select: { purchasePrice: true },
          })
        : Promise.resolve(null),
      needsUomGuard
        ? db.unitOfMeasure.findFirst({
            where: { id: dto.unitOfMeasureId!, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    if (needsUomGuard && !uom) {
      throw new BadRequestException('Одиницю виміру не знайдено в межах організації');
    }
    let resolvedCostPrice: number | null = dto.price ?? null;
    if (needsCostLookup) {
      resolvedCostPrice =
        goodForCost?.purchasePrice != null ? Number(goodForCost.purchasePrice) : 0;
    }

    if (dto.quantity < 0 || dto.type === 'RESERVATION' || dto.type === 'RESERVATION_RELEASE') {
      // sto-optimize: pre-check needs only counters — strip wire payload from full row.
      const item = await db.stockItem.findFirst({
        where: { orgId, goodId: dto.goodId, warehouseId: dto.warehouseId, deletedAt: null },
        select: { quantity: true, reserved: true },
      });
      const quantity = item?.quantity ?? 0;
      const reserved = item?.reserved ?? 0;
      const available = quantity - reserved;
      if (
        dto.quantity < 0 &&
        dto.type !== 'RESERVATION_RELEASE' &&
        available < Math.abs(dto.quantity)
      ) {
        throw new BadRequestException('Недостатньо товару на складі');
      }
      if (dto.type === 'RESERVATION' && dto.quantity > available) {
        throw new BadRequestException('Недостатньо доступного товару для резервування');
      }
      if (dto.type === 'RESERVATION_RELEASE' && Math.abs(dto.quantity) > reserved) {
        throw new BadRequestException(
          'Неможливо зняти резерв: зарезервована кількість менша за запитану',
        );
      }
    }

    const movement = await db.stockMovement.create({
      data: {
        orgId,
        goodId: dto.goodId,
        warehouseId: dto.warehouseId,
        type: dto.type,
        quantity: dto.quantity,
        price: dto.price ?? resolvedCostPrice,
        documentType: dto.documentType ?? null,
        documentId: dto.documentId ?? null,
        notes: dto.notes ?? null,
        createdBy: dto.createdBy ?? null,
        unitOfMeasureId: dto.unitOfMeasureId ?? null,
      },
    });

    if (dto.type === 'RECEIPT' && dto.quantity > 0) {
      await this.batchService.createFromReceipt(
        orgId,
        {
          goodId: dto.goodId,
          warehouseId: dto.warehouseId,
          purchaseOrderLineId: dto.purchaseOrderLineId,
          stockMovementId: movement.id,
          batchNumber: dto.batchNumber,
          expiryDate: dto.expiryDate,
          receivedQty: dto.quantity,
          costPrice: resolvedCostPrice ?? 0,
          unitOfMeasureId: dto.unitOfMeasureId ?? null,
        },
        db as Prisma.TransactionClient,
      );
    }

    // RESERVATION/RESERVATION_RELEASE only affect reserved counter, not physical quantity
    // WRITEOFF decrements quantity; reserved was already decremented by the prior RESERVATION_RELEASE call
    const quantityDelta =
      dto.type === 'RESERVATION' || dto.type === 'RESERVATION_RELEASE' ? 0 : dto.quantity;
    const reservedDelta =
      dto.type === 'RESERVATION'
        ? dto.quantity // positive → increases reserved
        : dto.type === 'RESERVATION_RELEASE'
          ? dto.quantity // negative → decreases reserved
          : 0;

    const upserted = await db.stockItem.upsert({
      where: {
        orgId_goodId_warehouseId: { orgId, goodId: dto.goodId, warehouseId: dto.warehouseId },
      },
      update: {
        quantity: { increment: quantityDelta },
        reserved: { increment: reservedDelta },
        // Ensure soft-deleted items are restored when a movement re-creates them
        deletedAt: null,
      },
      create: {
        orgId,
        goodId: dto.goodId,
        warehouseId: dto.warehouseId,
        quantity: quantityDelta,
        reserved: Math.max(0, reservedDelta),
      },
      select: { quantity: true, reserved: true },
    });

    // Bug #613 — race-guard: pre-check (рядок 118) читає STALE snapshot, тож два concurrent
    // WRITEOFF обидва проходять → row-locked upsert може лишити від'ємне значення. Post-check
    // читає підсумок ROW-LOCKED значення → throw → rollback усього $transaction. DB CHECK
    // (20260902210000) — джерело-правди backstop; ці throw дають локалізоване повідомлення.
    // Гейтимо за знаком дельти — на RECEIPT/RESERVATION приріст не може стати від'ємним.
    if (quantityDelta < 0 && upserted.quantity < 0) {
      throw new BadRequestException('Недостатньо товару на складі (concurrent WRITEOFF)');
    }
    if (reservedDelta < 0 && upserted.reserved < 0) {
      throw new BadRequestException(
        "Резерв не може стати від'ємним (concurrent RESERVATION_RELEASE)",
      );
    }

    // Партійне списання (COGS) для фізичного розходу: quantityDelta<0 (WRITEOFF/TRANSFER-out).
    // RESERVATION/RESERVATION_RELEASE не чіпають фізичну кількість → партій не торкаються.
    // Consume в тій самій tx, ПІСЛЯ upsert StockItem → інваріант Σ remainingQty == quantity
    // тримається за конструкцією. Метод списання (FIFO/FEFO/LIFO/AVG) — з налаштувань org.
    let consumed: BatchConsumeResult[] = [];
    let weightedCostPrice: number | null = null;
    if (quantityDelta < 0) {
      const costMethod = await this.resolveCostMethod(orgId);
      const consumeQty = Math.abs(quantityDelta);
      if (costMethod === 'AVG_COST') {
        // AVG_COST: собівартість = зважена середня ДО списання; фізичний декремент партій —
        // FIFO (щоб remainingQty спадав і не ламав інваріант; protected AVG-return не чіпаємо).
        weightedCostPrice = await this.batchService.getAvgCost(orgId, dto.goodId, dto.warehouseId);
        consumed = await this.batchService.consumeBatch(
          orgId,
          dto.goodId,
          dto.warehouseId,
          consumeQty,
          dto.documentType ?? 'StockMovement',
          dto.documentId ?? movement.id,
          dto.documentLineId,
          'FIFO',
          db as Prisma.TransactionClient,
        );
      } else {
        consumed = await this.batchService.consumeBatch(
          orgId,
          dto.goodId,
          dto.warehouseId,
          consumeQty,
          dto.documentType ?? 'StockMovement',
          dto.documentId ?? movement.id,
          dto.documentLineId,
          costMethod,
          db as Prisma.TransactionClient,
        );
        weightedCostPrice = weightedFromConsumed(consumed);
      }
      // Проставити batchId у рух коли списано рівно з однієї реальної партії (для трасування).
      // AVG_COST-агрегат → consumed[0].batchId === null (span теж не single) → пропускаємо.
      const singleBatchId = consumed.length === 1 ? consumed[0].batchId : null;
      if (singleBatchId) {
        await db.stockMovement.update({
          where: { id: movement.id },
          data: { batchId: singleBatchId },
        });
      }
    }

    return { movementId: movement.id, consumed, weightedCostPrice };
  }

  /** costMethod з налаштувань org (Redis-кешовано у SettingsService); fallback FIFO. */
  private async resolveCostMethod(orgId: string): Promise<BatchCostMethod> {
    try {
      const settings = await this.settingsService.getOrganisationSettings(orgId);
      return settings.costMethod ?? 'FIFO';
    } catch {
      return 'FIFO';
    }
  }

  async getStockLevel(
    orgId: string,
    goodId: string,
    warehouseId: string,
  ): Promise<{ quantity: number; reserved: number; available: number }> {
    // sto-optimize: read only the two counters needed for the response.
    const item = await this.prisma.stockItem.findFirst({
      where: { orgId, goodId, warehouseId, deletedAt: null },
      select: { quantity: true, reserved: true },
    });
    const quantity = item ? item.quantity : 0;
    const reserved = item ? item.reserved : 0;
    return { quantity, reserved, available: quantity - reserved };
  }

  async findStockItems(orgId: string, warehouseId?: string, goodId?: string, q?: string) {
    const where: Prisma.StockItemWhereInput = {
      orgId,
      deletedAt: null,
      good: q
        ? { deletedAt: null, name: { contains: q, mode: 'insensitive' } }
        : { deletedAt: null },
      warehouse: { deletedAt: null },
    };
    if (warehouseId) where.warehouseId = warehouseId;
    if (goodId) where.goodId = goodId;

    const items = await this.prisma.stockItem.findMany({
      where,
      include: {
        good: { select: { id: true, name: true, sku: true, unit: true, salePrice: true } },
        warehouse: { select: { id: true, name: true } },
      },
      orderBy: [{ warehouse: { name: 'asc' } }, { good: { name: 'asc' } }],
      take: 500,
    });

    return items.map(i => ({
      id: i.id,
      goodId: i.goodId,
      goodName: i.good.name,
      goodSku: i.good.sku,
      unit: i.good.unit,
      salePrice: Number(i.good.salePrice),
      warehouseId: i.warehouseId,
      warehouseName: i.warehouse.name,
      quantity: i.quantity,
      reserved: i.reserved,
      available: i.quantity - i.reserved,
      minStock: i.minStock ?? null,
      isLow: i.minStock != null && i.quantity <= i.minStock,
    }));
  }

  async findLowStockItems(orgId: string) {
    // Use raw query for cross-field comparison (quantity <= minStock) — Prisma doesn't support it in where.
    // Prisma schema uses camelCase without @map, so Postgres columns are camelCase and require double quotes.
    const rows = await this.prisma.$queryRaw<
      Array<{
        goodId: string;
        goodName: string;
        goodSku: string | null;
        unit: string;
        warehouseName: string;
        quantity: number;
        minStock: number;
      }>
    >`
      SELECT
        si."goodId"     AS "goodId",
        g.name          AS "goodName",
        g.sku           AS "goodSku",
        g.unit          AS unit,
        w.name          AS "warehouseName",
        si.quantity     AS quantity,
        si."minStock"   AS "minStock"
      FROM stock_items si
      JOIN goods g ON g.id = si."goodId"
      JOIN warehouses w ON w.id = si."warehouseId"
      WHERE si."orgId" = ${orgId}::uuid
        AND si."deletedAt" IS NULL
        AND g."deletedAt" IS NULL
        AND w."deletedAt" IS NULL
        AND si."minStock" IS NOT NULL
        AND si.quantity <= si."minStock"
      ORDER BY w.name, g.name
      LIMIT 500
    `;

    return rows.map(r => ({
      goodId: r.goodId,
      goodName: r.goodName,
      goodSku: r.goodSku,
      unit: r.unit,
      warehouseName: r.warehouseName,
      quantity: r.quantity,
      minStock: r.minStock,
      deficit: r.minStock - r.quantity,
    }));
  }

  private normalizeDates(from?: string, to?: string): { gte?: Date; lte?: Date } | undefined {
    if (!from && !to) return undefined;
    const range: { gte?: Date; lte?: Date } = {};
    if (from) {
      const d = new Date(`${from}T00:00:00Z`);
      range.gte = new Date(d.getTime() - kyivOffsetMs(d));
    }
    if (to) {
      const d = new Date(`${to}T23:59:59.999Z`);
      range.lte = new Date(d.getTime() - kyivOffsetMs(d));
    }
    return range;
  }

  private docLabel(documentType: string | null, documentId: string | null): string {
    const typePart = documentType ? (DOC_TYPE_LABELS[documentType] ?? documentType) : 'Документ';
    const idPart = documentId ? documentId.slice(0, 8) : '—';
    return `${typePart} ${idPart}`;
  }

  async byDocument(
    orgId: string,
    warehouseId?: string,
    goodId?: string,
    from?: string,
    to?: string,
  ) {
    const createdAt = this.normalizeDates(from, to);

    const [stockItems, movements] = await Promise.all([
      this.prisma.stockItem.findMany({
        where: {
          orgId,
          deletedAt: null,
          ...(warehouseId && { warehouseId }),
          ...(goodId && { goodId }),
          good: { deletedAt: null },
          warehouse: { deletedAt: null },
        },
        include: {
          good: {
            select: {
              name: true,
              sku: true,
              unit: true,
              brand: { select: { name: true } },
            },
          },
          warehouse: { select: { name: true } },
        },
        orderBy: [{ good: { name: 'asc' } }],
        take: 2000,
      }),
      this.prisma.stockMovement.findMany({
        where: {
          orgId,
          ...(warehouseId && { warehouseId }),
          ...(goodId && { goodId }),
          ...(createdAt && { createdAt }),
          // Не показувати рухи для soft-deleted товарів/складів — узгоджується
          // з фільтром на stockItem.findMany вище.
          good: { deletedAt: null },
          warehouse: { deletedAt: null },
        },
        orderBy: { createdAt: 'desc' },
        take: 3000,
      }),
    ]);

    // Build goodId → {qty, info} in a single pass
    type GoodInfo = { name: string; sku: string | null; unit: string; brand: string | null };
    const qtyMap = new Map<string, number>();
    const goodMap = new Map<string, GoodInfo>();
    for (const si of stockItems) {
      qtyMap.set(si.goodId, (qtyMap.get(si.goodId) ?? 0) + si.quantity);
      if (!goodMap.has(si.goodId)) {
        goodMap.set(si.goodId, {
          name: si.good.name,
          sku: si.good.sku,
          unit: si.good.unit,
          brand: si.good.brand?.name ?? null,
        });
      }
    }

    // Group movements by goodId → documentKey → movements[]
    type DocGroup = {
      documentType: string | null;
      documentId: string | null;
      docLabel: string;
      movements: { type: string; quantity: number; createdAt: Date }[];
    };
    const docsByGood = new Map<string, Map<string, DocGroup>>();

    for (const m of movements) {
      if (!docsByGood.has(m.goodId)) docsByGood.set(m.goodId, new Map());
      const docKey = `${m.documentType ?? ''}::${m.documentId ?? ''}`;
      const docs = docsByGood.get(m.goodId)!;
      if (!docs.has(docKey)) {
        docs.set(docKey, {
          documentType: m.documentType,
          documentId: m.documentId,
          docLabel: this.docLabel(m.documentType, m.documentId),
          movements: [],
        });
      }
      docs
        .get(docKey)!
        .movements.push({ type: m.type, quantity: m.quantity, createdAt: m.createdAt });
    }

    // Merge: only goods that appear in stockItems (current balance holders)
    const goods = Array.from(goodMap.entries()).map(([gId, info]) => ({
      goodId: gId,
      goodName: info.name,
      goodSku: info.sku,
      goodBrand: info.brand,
      goodUnit: info.unit,
      totalQuantity: qtyMap.get(gId) ?? 0,
      documents: Array.from(docsByGood.get(gId)?.values() ?? []),
    }));

    goods.sort((a, b) => a.goodName.localeCompare(b.goodName, 'uk'));

    return { goods };
  }

  async byBatch(orgId: string, warehouseId?: string, goodId?: string, from?: string, to?: string) {
    const createdAt = this.normalizeDates(from, to);

    const batches = await this.prisma.stockBatch.findMany({
      where: {
        orgId,
        ...(warehouseId && { warehouseId }),
        ...(goodId && { goodId }),
        ...(createdAt && { createdAt }),
        // Bug-prevention parity з byDocument: не показувати батчі для soft-deleted
        // товарів/складів (StockBatch не має власного deletedAt, але добра практика
        // обмежити вибірку активними сутностями).
        good: { deletedAt: null },
        warehouse: { deletedAt: null },
      },
      include: {
        good: {
          select: {
            name: true,
            sku: true,
            brand: { select: { name: true } },
          },
        },
        warehouse: { select: { name: true } },
        purchaseOrderLine: {
          select: {
            purchaseOrder: { select: { number: true, documentDate: true } },
          },
        },
        consumptions: {
          select: {
            quantity: true,
            documentType: true,
            documentId: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    // Group by PO key: poNumber + warehouseName.
    // BatchConsumption.documentType + documentId — NON-null per schema
    // (packages/database/prisma/schema.prisma:1212-1213); keep types tight so
    // frontend `BatchConsumptionRow` (non-null) stays in sync.
    type ConsumptionRow = {
      documentType: string;
      documentId: string;
      docLabel: string;
      quantity: number;
      createdAt: Date;
    };
    type GoodInBatch = {
      goodId: string;
      goodName: string;
      goodSku: string | null;
      goodBrand: string | null;
      batchId: string;
      batchNumber: string | null;
      receivedQty: number;
      remainingQty: number;
      costPrice: number;
      salePrice: number;
      consumptions: ConsumptionRow[];
    };
    type BatchGroup = {
      batchGroupKey: string;
      poNumber: string | null;
      poDate: Date | null;
      warehouseName: string;
      goods: GoodInBatch[];
    };

    const groupMap = new Map<string, BatchGroup>();

    for (const b of batches) {
      const po = b.purchaseOrderLine?.purchaseOrder;
      const groupKey = `${po?.number ?? 'manual'}::${b.warehouseId}`;
      if (!groupMap.has(groupKey)) {
        groupMap.set(groupKey, {
          batchGroupKey: groupKey,
          poNumber: po?.number ?? null,
          poDate: po?.documentDate ?? null,
          warehouseName: b.warehouse.name,
          goods: [],
        });
      }
      groupMap.get(groupKey)!.goods.push({
        goodId: b.goodId,
        goodName: b.good.name,
        goodSku: b.good.sku,
        goodBrand: b.good.brand?.name ?? null,
        batchId: b.id,
        batchNumber: b.batchNumber,
        receivedQty: b.receivedQty,
        remainingQty: b.remainingQty,
        costPrice: Number(b.costPrice),
        salePrice: Number(b.salePrice),
        consumptions: b.consumptions.map(c => ({
          documentType: c.documentType,
          documentId: c.documentId,
          docLabel: this.docLabel(c.documentType, c.documentId),
          quantity: c.quantity,
          createdAt: c.createdAt,
        })),
      });
    }

    return { batches: Array.from(groupMap.values()) };
  }

  async updateMinStock(
    orgId: string,
    stockItemId: string,
    minStock: number | null,
  ): Promise<{ id: string; minStock: number | null }> {
    // updateMany з orgId+deletedAt — захищає tenant ізоляцію + soft-delete за 1 RTT
    // (раніше findFirst → if(!item) throw → update робив 2 RTT, де перший лише для 404).
    const res = await this.prisma.stockItem.updateMany({
      where: { id: stockItemId, orgId, deletedAt: null },
      data: { minStock },
    });
    if (res.count === 0) throw new NotFoundException('Залишок не знайдено');
    return { id: stockItemId, minStock };
  }
}
