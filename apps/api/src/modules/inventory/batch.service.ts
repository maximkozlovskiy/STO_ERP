import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma, BatchCostMethod, StockBatch } from '@prisma/client';
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

    const good = await db.good.findFirst({
      where: { id: dto.goodId, orgId, deletedAt: null },
      select: {
        id: true,
        category: true,
        goodType: true,
        salePrice: true,
        brandId: true,
        unitId: true,
      },
    });
    if (!good) throw new BadRequestException('Товар не знайдено');

    const resolvedUnitOfMeasureId = dto.unitOfMeasureId ?? good.unitId ?? null;

    const currentSalePriceForBatch = Number(good.salePrice);
    const computedSalePrice = await this.pricing.calculateSalePrice(
      orgId,
      dto.goodId,
      good.category ?? null,
      good.goodType ?? null,
      good.brandId ?? null,
      dto.costPrice,
    );
    // Bug #14: при безкоштовному прийомі (costPrice=0) використовуємо поточну ціну товару,
    // щоб не записати партію з salePrice=0 і не зламати наступні продажі.
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
    // Bug #14: безкоштовний прийом (costPrice=0 → salePrice=0) НЕ повинен затирати поточну salePrice.
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
   * Bug #20: Якщо `tx` не передано — обгортаємо роботу в `$transaction`, щоб
   * `stockBatch.update` і `batchConsumption.create` були атомарними. Інакше
   * краш між двома операціями залишить партію без consumption-логу.
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
      // Bug #132: explicit timeout — batch consume може touchнути 10+ батчів
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

    // Find batches by method
    // Bug #133: FEFO має explicit `nulls: 'last'` — товари без терміну йдуть В КІНЦІ (не випадково через Postgres default).
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

      await db.stockBatch.update({
        where: { id: batch.id },
        data: {
          remainingQty: { decrement: take },
          isActive: batch.remainingQty - take > 0,
        },
      });

      await db.batchConsumption.create({
        data: {
          orgId,
          batchId: batch.id,
          goodId,
          quantity: -take,
          documentType,
          documentId,
          documentLineId: documentLineId ?? null,
        },
      });

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
    // Bug #16: warehouseId опціональний. Якщо не передано — агрегуємо по всіх складах.
    // Порожній рядок раніше зі сторони контролера трактувався як склад "" → 0 партій.
    const filter = warehouseId
      ? { orgId, goodId, warehouseId, isActive: true, remainingQty: { gt: 0 } }
      : { orgId, goodId, isActive: true, remainingQty: { gt: 0 } };
    const batches = await this.prisma.stockBatch.findMany({
      where: filter,
      select: { remainingQty: true, costPrice: true },
      take: 500,
    });
    if (!batches.length) return 0;
    const totalCost = batches.reduce((sum, b) => sum + b.remainingQty * Number(b.costPrice), 0);
    const totalQty = batches.reduce((sum, b) => sum + b.remainingQty, 0);
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
   * Bug #20: Якщо `tx` не передано — обгортаємо роботу в `$transaction`, щоб
   * `stockBatch.update` і `batchConsumption.create` були атомарними.
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
      // Bug #132: explicit timeout
      await this.prisma.$transaction(
        innerTx => this.returnToBatch(orgId, batchId, qty, documentType, documentId, innerTx),
        { timeout: 5_000 },
      );
      return;
    }
    const db = tx;
    const batch = await db.stockBatch.findFirst({
      where: { id: batchId, orgId },
    });
    if (!batch) throw new BadRequestException('Партію не знайдено');

    await db.stockBatch.update({
      where: { id: batchId },
      data: { remainingQty: { increment: qty }, isActive: true },
    });

    await db.batchConsumption.create({
      data: { orgId, batchId, goodId: batch.goodId, quantity: qty, documentType, documentId },
    });
  }
}
