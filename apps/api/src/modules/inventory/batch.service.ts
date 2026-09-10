import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma, BatchCostMethod, StockBatch } from '@prisma/client';
import { TRANSACTION_TIMEOUT_MS } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { PricingService } from './pricing.service';

/**
 * remainingQty/receivedQty — Float у схемі (підтримує дробові одиниці: літри мастила тощо).
 * Через IEEE-754 `remainingQty - take` дає залишок ~1e-14 замість 0 → партія-«привид»
 * лишалась isActive з мікрозалишком, забруднюючи FEFO-обхід. EPSILON квантизує «майже нуль».
 */
const QTY_EPSILON = 1e-9;

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
  /**
   * ID реальної партії, з якої списано. `null` — коли рядок не відповідає одній фізичній
   * партії (AVG_COST-агрегат): `StockMovement.batchId`/`WorkOrderPart.batchId` — nullable
   * `@db.Uuid`, тож `null` присвоюється напряму без гейта у викликачів (порожній рядок
   * пробивав би "invalid input syntax for type uuid").
   */
  batchId: string | null;
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
        where: { id: dto.goodId, orgId },
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
      // AVG_COST — no batch tracking, just return avg cost for reference.
      // batchId: null — агрегат не відповідає одній партії; викликач присвоює null у
      // nullable uuid-колонку без гейта (див. BatchConsumeResult.batchId).
      // tx-read (db): consumeBatch завжди у $transaction (guard вище) → getAvgCost мусить
      // бачити uncommitted стан тієї ж tx і серіалізуватись з consume (той самий tx-read
      // fix, що у inventory.service AVG_COST-гілці).
      const avgCost = await this.getAvgCost(orgId, goodId, warehouseId, db);
      return [{ batchId: null, quantity: qty, costPrice: avgCost }];
    }

    // FEFO requires explicit `nulls: 'last'` — goods without expiry must go LAST; Postgres default for ASC is nulls-last only for some versions.
    const orderBy: Prisma.StockBatchOrderByWithRelationInput[] =
      costMethod === 'LIFO'
        ? [{ createdAt: 'desc' }]
        : costMethod === 'FEFO'
          ? [{ expiryDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }]
          : [{ createdAt: 'asc' }]; // FIFO default

    let remaining = qty;
    const results: BatchConsumeResult[] = [];
    const PAGE = 100;

    // While-пагінація: списання може зачепити >100 партій (span). Кожна сторінка
    // вибирає активні партії з remainingQty>0 у порядку costMethod; після декременту
    // наступна сторінка природно бере наступні. Guard `progressed` проти нескінченного
    // циклу якщо БД раптом віддала партії без remainingQty.
    while (remaining > 0) {
      const batches = await db.stockBatch.findMany({
        where: { orgId, goodId, warehouseId, isActive: true, remainingQty: { gt: 0 } },
        orderBy,
        take: PAGE,
      });
      if (batches.length === 0) break;
      let progressed = false;

      for (const batch of batches) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, batch.remainingQty);
        if (take <= 0) continue;

        // Bug #613 — race-guard: conditional decrement (WHERE remainingQty >= take) — CAS проти
        // concurrent consume того ж батча (STALE findMany snapshot). count=0 при програній гонці
        // → throw → $transaction rollback (скасовує і batchConsumption). DB CHECK
        // (stock_batches_remaining_nonneg, 20260902210000) — backstop джерело-правди.
        // update + create незалежні → Promise.all (−1 RTT на батч).
        const [updated] = await Promise.all([
          db.stockBatch.updateMany({
            // orgId — defense-in-depth (id вже UUID PK з orgId-scoped findMany; CLAUDE.md #6).
            where: { id: batch.id, orgId, remainingQty: { gte: take } },
            data: {
              remainingQty: { decrement: take },
              // EPSILON-квантизація: залишок ≤ 1e-9 вважаємо вичерпаним (float-дрейф), інакше
              // партія-привид лишається isActive і забруднює наступні FEFO-обходи.
              isActive: batch.remainingQty - take > QTY_EPSILON,
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

        if (updated.count === 0) {
          // Race lost: інший tx декрементив партію між findMany і updateMany. Скасовуємо
          // batchConsumption через throw → $transaction rollback (Promise.all виконаний, але
          // весь ланцюг ще у tx). Наступний retry рівня викликача (WO/Invoice) з'ясує стан.
          throw new BadRequestException('Партію змінено іншою транзакцією — повторіть операцію');
        }

        results.push({ batchId: batch.id, quantity: take, costPrice: Number(batch.costPrice) });
        remaining -= take;
        progressed = true;
      }
      // Уся сторінка активних партій оброблена, але борг лишився і прогресу нема —
      // далі партій нема (менше за PAGE) або аномалія → виходимо у throw нижче.
      if (!progressed || batches.length < PAGE) break;
    }

    // EPSILON-квантизація і тут: залишок ≤ 1e-9 після span'у по дробових партіях — це
    // float-дрейф (0.3 − 0.1 − 0.1 − 0.1 ≈ 2.7e-17), а не реальна нестача. Без порогу
    // законне повне списання дробової кількості кидало б хибне «бракує 2.7e-17 одиниць».
    if (remaining > QTY_EPSILON) {
      throw new BadRequestException(
        `Недостатньо партій для списання: бракує ${remaining} одиниць товару`,
      );
    }

    return results;
  }

  async getAvgCost(
    orgId: string,
    goodId: string,
    warehouseId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    // warehouseId is optional — omit to aggregate across all warehouses.
    // An empty-string warehouse was previously treated as warehouse "" → 0 batches.
    // Зважена середня = SUM(remainingQty*costPrice)/SUM(remainingQty) по ВСІХ активних партіях.
    // SUM агрегує в БД і повертає один рядок незалежно від кількості партій — тож LIMIT не
    // потрібен для продуктивності, а раніше вносив зміщення: при >500 партій найстаріші
    // (які FIFO/FEFO списує ПЕРШИМИ) випадали з cost-basis → COGS завищений. Без LIMIT — точно.
    // tx: коли викликано всередині $transaction (AVG_COST COGS у createMovement), читаємо ЧЕРЕЗ
    // tx, щоб бачити uncommitted RECEIPT тієї ж tx і бути серіалізованим з consume (інакше COGS
    // рахувався б зі snapshot, що не збігається з фактично списаними партіями).
    const client = tx ?? this.prisma;
    type AvgCostRow = { total_cost: number | null; total_qty: number | null };
    const rows = warehouseId
      ? await client.$queryRaw<AvgCostRow[]>`
          SELECT
            COALESCE(SUM("remainingQty" * "costPrice"), 0)::float AS total_cost,
            COALESCE(SUM("remainingQty"),               0)::float AS total_qty
          FROM stock_batches
          WHERE "orgId" = ${orgId}::uuid
            AND "goodId" = ${goodId}::uuid
            AND "warehouseId" = ${warehouseId}::uuid
            AND "isActive" = true
            AND "remainingQty" > 0
        `
      : await client.$queryRaw<AvgCostRow[]>`
          SELECT
            COALESCE(SUM("remainingQty" * "costPrice"), 0)::float AS total_cost,
            COALESCE(SUM("remainingQty"),               0)::float AS total_qty
          FROM stock_batches
          WHERE "orgId" = ${orgId}::uuid
            AND "goodId" = ${goodId}::uuid
            AND "isActive" = true
            AND "remainingQty" > 0
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
    // Tenant guard + receivedQty (потрібен для верхньої межі повернення).
    const batch = await db.stockBatch.findFirst({
      where: { id: batchId, orgId },
      select: { goodId: true, receivedQty: true },
    });
    if (!batch) throw new BadRequestException('Партію не знайдено');

    // Ідемпотентність: повторний виклик на той самий (батч, документ) не подвоює повернення
    // (BullMQ retry / double-click). Return-consumption має quantity > 0 (споживання — < 0).
    const existing = await db.batchConsumption.findFirst({
      where: { orgId, batchId, documentType, documentId, quantity: { gt: 0 } },
      select: { id: true },
    });
    if (existing) return;

    // CAS-guard + верхній cap (дзеркалить consumeBatch): remainingQty НЕ може перевищити
    // receivedQty (інваріант Σ remaining(active) == StockItem.quantity — повернути більше ніж
    // отримано неможливо). `remainingQty <= receivedQty - qty` → після +qty буде ≤ receivedQty.
    // count=0 → або зникла партія (гонка), або повернення перевищує залишок місткості → throw.
    const [updated] = await Promise.all([
      db.stockBatch.updateMany({
        where: { id: batchId, orgId, remainingQty: { lte: batch.receivedQty - qty } },
        data: { remainingQty: { increment: qty }, isActive: true },
      }),
      db.batchConsumption.create({
        data: { orgId, batchId, goodId: batch.goodId, quantity: qty, documentType, documentId },
      }),
    ]);
    if (updated.count === 0) {
      // throw → $transaction rollback (скасовує batchConsumption).
      throw new BadRequestException('Повернення перевищує отриману кількість партії');
    }
  }
}
