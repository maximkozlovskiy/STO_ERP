import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma, BatchCostMethod, StockBatch } from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { PricingService } from './pricing.service';

export interface CreateBatchDto {
  goodId: string;
  warehouseId: string;
  purchaseOrderLineId?: string;
  stockMovementId: string;
  batchNumber?: string;
  expiryDate?: Date;
  receivedQty: number;
  costPrice: number;
  unitOfMeasureId?: string | null;
}

export interface BatchConsumeResult {
  batchId: string;
  quantity: number;
  costPrice: number;
}

export interface StockBatchDto {
  id: string;
  goodId: string;
  warehouseId: string;
  purchaseOrderLineId: string | null;
  batchNumber: string | null;
  expiryDate: Date | null;
  receivedQty: number;
  remainingQty: number;
  costPrice: number;
  salePrice: number;
  isActive: boolean;
  createdAt: Date;
  purchaseOrderNumber?: string | null;
  unitOfMeasureId: string | null;
  unitShortName: string | null;
}

@Injectable()
export class BatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
  ) {}

  async createFromReceipt(
    orgId: string,
    dto: CreateBatchDto,
    tx?: Prisma.TransactionClient,
  ): Promise<StockBatch> {
    const db = tx ?? this.prisma;

    // Parallel: good fetch + pricing rules — обидва не залежать одне від одного.
    // Раніше було послідовно: good.findFirst → calculateSalePrice (який внутрішньо тягнув rules).
    // Тепер один RTT на обидва. computePriceFromRules — синхронний компуть.
    const [good, allRules] = await Promise.all([
      db.good.findFirst({
        where: { id: dto.goodId, orgId, deletedAt: null },
        select: {
          id: true,
          category: true,
          goodType: true,
          salePrice: true,
          brandId: true,
          unitId: true,
        },
      }),
      this.pricing.getActiveRulesForOrg(orgId),
    ]);
    if (!good) throw new BadRequestException('Товар не знайдено');

    const resolvedUnitOfMeasureId = dto.unitOfMeasureId ?? good.unitId ?? null;

    const currentSalePriceForBatch = Number(good.salePrice);
    const computedSalePrice = this.pricing.computePriceFromRules(
      allRules,
      dto.goodId,
      good.category ?? undefined,
      good.goodType ?? undefined,
      good.brandId ?? undefined,
      dto.costPrice,
    );
    // Free receipt (costPrice=0): use current good price to avoid recording a batch with salePrice=0
    // which would break subsequent sales.
    const salePrice =
      dto.costPrice > 0 && computedSalePrice > 0 ? computedSalePrice : currentSalePriceForBatch;

    const batch = await db.stockBatch.create({
      data: {
        orgId,
        goodId: dto.goodId,
        warehouseId: dto.warehouseId,
        purchaseOrderLineId: dto.purchaseOrderLineId ?? null,
        stockMovementId: dto.stockMovementId,
        batchNumber: dto.batchNumber ?? null,
        expiryDate: dto.expiryDate ?? null,
        receivedQty: dto.receivedQty,
        remainingQty: dto.receivedQty,
        costPrice: dto.costPrice,
        salePrice,
        unitOfMeasureId: resolvedUnitOfMeasureId,
      },
    });

    // Update Good.salePrice and log PriceHistory if price changed.
    // Free receipt (costPrice=0 → salePrice=0) must NOT overwrite the current salePrice.
    const currentSalePrice = Number(good.salePrice);
    const canUpdateSalePrice =
      dto.costPrice > 0 && salePrice > 0 && Math.abs(salePrice - currentSalePrice) > 0.001;
    if (canUpdateSalePrice) {
      await db.good.update({
        where: { id: dto.goodId },
        data: { salePrice },
      });
      await db.priceHistory.create({
        data: {
          orgId,
          goodId: dto.goodId,
          oldPrice: currentSalePrice,
          newPrice: salePrice,
          costPrice: dto.costPrice,
          reason: 'Batch receipt',
          batchId: batch.id,
        },
      });
    }

    return batch;
  }

  /**
   * Consume `qty` units of a good from active batches using the given cost method.
   *
   * If `tx` is not provided, wraps in `$transaction` so `stockBatch.update` and
   * `batchConsumption.create` are atomic — a crash between the two would leave a batch
   * with no consumption log.
   */
  async consumeBatch(
    orgId: string,
    goodId: string,
    warehouseId: string,
    qty: number,
    documentType: string,
    documentId: string,
    documentLineId: string | undefined,
    costMethod: BatchCostMethod,
    tx?: Prisma.TransactionClient,
  ): Promise<BatchConsumeResult[]> {
    if (!tx) {
      // Explicit timeout: consume can touch 10+ batches in a loop, exceeding the 5s Prisma default.
      return this.prisma.$transaction(
        innerTx =>
          this.consumeBatch(
            orgId,
            goodId,
            warehouseId,
            qty,
            documentType,
            documentId,
            documentLineId,
            costMethod,
            innerTx,
          ),
        { timeout: 10_000 },
      );
    }
    const db = tx;

    if (costMethod === 'AVG_COST') {
      // AVG_COST — no batch tracking, just return avg cost for reference
      const avgCost = await this.getAvgCost(orgId, goodId, warehouseId);
      return [{ batchId: '', quantity: qty, costPrice: avgCost }];
    }

    // FEFO requires explicit `nulls: 'last'` — goods without expiry must go LAST; Postgres default for ASC is nulls-last only for some versions.
    const orderBy: Prisma.StockBatchOrderByWithRelationInput[] =
      costMethod === 'LIFO'
        ? [{ createdAt: 'desc' }]
        : costMethod === 'FEFO'
          ? [{ expiryDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }]
          : [{ createdAt: 'asc' }]; // FIFO default

    const batches = await db.stockBatch.findMany({
      where: { orgId, goodId, warehouseId, isActive: true, remainingQty: { gt: 0 } },
      orderBy,
      take: 100,
    });

    let remaining = qty;
    const results: BatchConsumeResult[] = [];

    for (const batch of batches) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, batch.remainingQty);

      // sto-optimize: update + create на ОДНУ ітерацію не залежать один від
      // одного — Promise.all зекономить 1 RTT на батч. Loop-carried лишається
      // (`remaining -= take`), тому ітерації між собою сериалізовані як і раніше.
      await Promise.all([
        db.stockBatch.update({
          where: { id: batch.id },
          data: {
            remainingQty: { decrement: take },
            isActive: batch.remainingQty - take > 0,
          },
        }),
        db.batchConsumption.create({
          data: {
            orgId,
            batchId: batch.id,
            goodId,
            quantity: -take,
            documentType,
            documentId,
            documentLineId: documentLineId ?? null,
          },
        }),
      ]);

      results.push({ batchId: batch.id, quantity: take, costPrice: Number(batch.costPrice) });
      remaining -= take;
    }

    if (remaining > 0) {
      throw new BadRequestException(
        `Недостатньо партій для списання: бракує ${remaining} одиниць товару`,
      );
    }

    return results;
  }

  async getAvgCost(orgId: string, goodId: string, warehouseId?: string): Promise<number> {
    // warehouseId is optional — omit to aggregate across all warehouses.
    // An empty-string warehouse was previously treated as warehouse "" → 0 batches.
    // Postgres weighted SUM in a single query vs findMany(take:500) + JS reduce saves
    // row marshaling on this hot-path (consumeBatch AVG_COST, every WO sale/writeoff).
    // Determinism preserved: ORDER BY createdAt DESC + LIMIT 500 in the CTE.
    type AvgCostRow = { total_cost: number | null; total_qty: number | null };
    const rows = warehouseId
      ? await this.prisma.$queryRaw<AvgCostRow[]>`
          WITH recent AS (
            SELECT "remainingQty", "costPrice"
            FROM stock_batches
            WHERE "orgId" = ${orgId}::uuid
              AND "goodId" = ${goodId}::uuid
              AND "warehouseId" = ${warehouseId}::uuid
              AND "isActive" = true
              AND "remainingQty" > 0
            ORDER BY "createdAt" DESC
            LIMIT 500
          )
          SELECT
            COALESCE(SUM("remainingQty" * "costPrice"), 0)::float AS total_cost,
            COALESCE(SUM("remainingQty"),               0)::float AS total_qty
          FROM recent
        `
      : await this.prisma.$queryRaw<AvgCostRow[]>`
          WITH recent AS (
            SELECT "remainingQty", "costPrice"
            FROM stock_batches
            WHERE "orgId" = ${orgId}::uuid
              AND "goodId" = ${goodId}::uuid
              AND "isActive" = true
              AND "remainingQty" > 0
            ORDER BY "createdAt" DESC
            LIMIT 500
          )
          SELECT
            COALESCE(SUM("remainingQty" * "costPrice"), 0)::float AS total_cost,
            COALESCE(SUM("remainingQty"),               0)::float AS total_qty
          FROM recent
        `;
    const totalCost = Number(rows[0]?.total_cost ?? 0);
    const totalQty = Number(rows[0]?.total_qty ?? 0);
    return totalQty > 0 ? totalCost / totalQty : 0;
  }

  async getBatchesForGood(
    orgId: string,
    goodId: string,
    warehouseId?: string,
  ): Promise<StockBatchDto[]> {
    const batches = await this.prisma.stockBatch.findMany({
      where: { orgId, goodId, ...(warehouseId ? { warehouseId } : {}) },
      include: {
        purchaseOrderLine: {
          include: { purchaseOrder: { select: { number: true } } },
        },
        unitOfMeasure: { select: { shortName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return batches.map(b => ({
      id: b.id,
      goodId: b.goodId,
      warehouseId: b.warehouseId,
      purchaseOrderLineId: b.purchaseOrderLineId,
      batchNumber: b.batchNumber,
      expiryDate: b.expiryDate,
      receivedQty: b.receivedQty,
      remainingQty: b.remainingQty,
      costPrice: Number(b.costPrice),
      salePrice: Number(b.salePrice),
      isActive: b.isActive,
      createdAt: b.createdAt,
      purchaseOrderNumber: b.purchaseOrderLine?.purchaseOrder?.number ?? null,
      unitOfMeasureId: b.unitOfMeasureId,
      unitShortName: b.unitOfMeasure?.shortName ?? null,
    }));
  }

  /**
   * Return `qty` units to an existing batch (e.g. WO cancellation).
   *
   * If `tx` is not provided, wraps in `$transaction` so `stockBatch.update` and
   * `batchConsumption.create` are atomic.
   */
  async returnToBatch(
    orgId: string,
    batchId: string,
    qty: number,
    documentType: string,
    documentId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!tx) {
      await this.prisma.$transaction(
        innerTx => this.returnToBatch(orgId, batchId, qty, documentType, documentId, innerTx),
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
      return;
    }
    const db = tx;
    // sto-optimize: tenant guard читає лише goodId — інші колонки не потрібні.
    const batch = await db.stockBatch.findFirst({
      where: { id: batchId, orgId },
      select: { goodId: true },
    });
    if (!batch) throw new BadRequestException('Партію не знайдено');

    // sto-optimize: update + create не залежать один від одного — Promise.all
    // економить 1 RTT (важливо у WO cancellation hot-path де returnToBatch
    // викликається у циклі по parts[]).
    await Promise.all([
      db.stockBatch.update({
        where: { id: batchId },
        data: { remainingQty: { increment: qty }, isActive: true },
      }),
      db.batchConsumption.create({
        data: { orgId, batchId, goodId: batch.goodId, quantity: qty, documentType, documentId },
      }),
    ]);
  }
}
