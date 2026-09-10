import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { safeCoeff, roundMoney } from '../../common/utils/math';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';

/**
 * A3 (розбиття God-об'єктів): transaction-critical stock+settlement side-effects FSM-переходів наряду —
 * окремий bounded context (склад+баланс), винесений з WorkOrdersService.transition. Резерв/списання/
 * повернення запчастин (через InventoryService.createMovement) + борг/сторно (через
 * SettlementsService.createTransaction). Усі методи приймають `tx` і викликаються ВСЕРЕДИНІ
 * transition-$transaction — ефекти атомарні зі зміною статусу.
 *
 * ⚠️ Уся логіка перенесена ДОСЛІВНО з WorkOrdersService (behavior-identical), окрім однієї виправленої
 * латентної помилки: fetchPartCoefficients тепер фільтрує GoodUoM за orgId (tenant-isolation).
 */
@Injectable()
export class WorkOrderStockEffectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly settlements: SettlementsService,
  ) {}

  async reserveParts(
    orgId: string,
    workOrderId: string,
    userId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;
    const parts = await db.workOrderPart.findMany({
      where: { workOrderId, orgId, deletedAt: null },
      take: 1000,
    });
    // Batch-fetch GoodUoM coefficients for qty conversion: qty_base = qty / coefficient
    const coeffMap = await this.fetchPartCoefficients(orgId, parts, db);

    for (const part of parts) {
      const coeff = coeffMap[part.id] ?? 1;
      await this.inventory.createMovement(
        orgId,
        {
          goodId: part.goodId,
          warehouseId: part.warehouseId,
          type: 'RESERVATION',
          quantity: part.quantity / coeff,
          documentType: 'WorkOrder',
          documentId: workOrderId,
          createdBy: userId,
        },
        db,
      );
    }
  }

  async releasePartReservations(
    orgId: string,
    workOrderId: string,
    userId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;
    const parts = await db.workOrderPart.findMany({
      where: { workOrderId, orgId, deletedAt: null },
      take: 1000,
    });
    const coeffMap = await this.fetchPartCoefficients(orgId, parts, db);

    for (const part of parts) {
      const coeff = coeffMap[part.id] ?? 1;
      await this.inventory.createMovement(
        orgId,
        {
          goodId: part.goodId,
          warehouseId: part.warehouseId,
          type: 'RESERVATION_RELEASE',
          quantity: -(part.quantity / coeff),
          documentType: 'WorkOrder',
          documentId: workOrderId,
          createdBy: userId,
        },
        db,
      );
    }
  }

  async writeOffPartsAndCharge(
    orgId: string,
    wo: { id: string; counterpartyId: string; totalAmount: Prisma.Decimal | null },
    userId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;
    const parts = await db.workOrderPart.findMany({
      where: { workOrderId: wo.id, orgId, deletedAt: null },
      take: 1000,
    });
    const coeffMap = await this.fetchPartCoefficients(orgId, parts, db);

    for (const part of parts) {
      const coeff = coeffMap[part.id] ?? 1;
      const baseQty = part.quantity / coeff;
      // Logic-bug fix: release the reservation BEFORE writeoff. InventoryService.createMovement
      // gates WRITEOFF on `available = quantity - reserved >= |qty|`. Якщо весь фізичний
      // залишок зарезервовано саме цим нарядом (квантитет = резерв = baseQty), available=0
      // і WRITEOFF падає з "Недостатньо товару на складі" попри те, що фізичні запчастини
      // на складі присутні. Послідовність RELEASE → WRITEOFF: спочатку звільняємо резерв
      // (reserved -= baseQty), потім списуємо (тепер available = quantity > 0).
      await this.inventory.createMovement(
        orgId,
        {
          goodId: part.goodId,
          warehouseId: part.warehouseId,
          type: 'RESERVATION_RELEASE',
          quantity: -baseQty,
          documentType: 'WorkOrder',
          documentId: wo.id,
          createdBy: userId,
        },
        db,
      );
      // WRITEOFF списує партії (FIFO/costMethod з налаштувань) і повертає реальну
      // собівартість (COGS). НЕ передаємо price=part.price (то ЦІНА ПРОДАЖУ) — собівартість
      // визначається партіями. Фіксуємо batchCostPrice/batchId у part для звіту рентабельності.
      const writeoff = await this.inventory.createMovement(
        orgId,
        {
          goodId: part.goodId,
          warehouseId: part.warehouseId,
          type: 'WRITEOFF',
          quantity: -baseQty,
          documentType: 'WorkOrder',
          documentId: wo.id,
          documentLineId: part.id,
          createdBy: userId,
        },
        db,
      );
      if (writeoff.weightedCostPrice != null) {
        // batchId лише коли списано рівно з однієї реальної партії. AVG_COST-агрегат
        // повертає batchId=null, span — length>1 → обидва дають null (нема single-batch
        // трасування). Нижче NULL коректно лягає у nullable uuid WorkOrderPart.batchId.
        const singleBatchId = writeoff.consumed.length === 1 ? writeoff.consumed[0].batchId : null;
        await db.workOrderPart.update({
          where: { id: part.id, orgId },
          data: {
            batchCostPrice: writeoff.weightedCostPrice,
            batchId: singleBatchId,
          },
        });
      }
    }
    // WO-H1: сума боргу — з IN-TX re-read totalAmount (не зі stale pre-tx знімка wo). Concurrent
    // addLine/updatePart міг змінити суму через recalcTotals між pre-tx read і цією транзакцією.
    const freshWo = await db.workOrder.findFirst({
      where: { id: wo.id, orgId },
      select: { totalAmount: true },
    });
    const chargeAmount = roundMoney(Number(freshWo?.totalAmount ?? wo.totalAmount ?? 0));
    if (chargeAmount <= 0)
      throw new BadRequestException('Загальна сума наряду дорівнює нулю — завершення неможливе');
    await this.settlements.createTransaction(
      orgId,
      {
        counterpartyId: wo.counterpartyId,
        type: 'CHARGE',
        amount: chargeAmount,
        documentType: 'WorkOrder',
        documentId: wo.id,
        createdBy: userId,
      },
      db,
    );
  }

  /**
   * C2 — реверс writeOffPartsAndCharge при COMPLETED→CANCELLED. Дзеркалить його per-part:
   * замість WRITEOFF(−q) робимо RETURN(+q) (InventoryService інкрементує StockItem + повертає
   * у ті самі партії через returnToBatch), замість CHARGE — один CREDIT_NOTE на суму боргу
   * → баланс документа нетиться до нуля. Резерв НЕ відновлюємо (на COMPLETED його вже знято).
   * Викликається лише з CANCELLED-гілки transition() під wo.status==='COMPLETED' → single-shot
   * (in-tx status re-read + термінальний CANCELLED, як double-CHARGE guard).
   */
  async returnPartsAndCredit(
    orgId: string,
    wo: { id: string; counterpartyId: string; totalAmount: Prisma.Decimal | null },
    userId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;
    const parts = await db.workOrderPart.findMany({
      where: { workOrderId: wo.id, orgId, deletedAt: null },
      take: 1000,
    });
    const coeffMap = await this.fetchPartCoefficients(orgId, parts, db);

    for (const part of parts) {
      const coeff = coeffMap[part.id] ?? 1;
      const baseQty = part.quantity / coeff;
      // RETURN дзеркалить WRITEOFF: та сама baseQty, той самий (documentType, documentId,
      // documentLineId). InventoryService інкрементує StockItem і повертає партії (агрегує по
      // batchId у межах документа). batchCostPrice/batchId у WorkOrderPart НЕ чистимо —
      // історичний COGS-запис.
      await this.inventory.createMovement(
        orgId,
        {
          goodId: part.goodId,
          warehouseId: part.warehouseId,
          type: 'RETURN',
          quantity: baseQty,
          documentType: 'WorkOrder',
          documentId: wo.id,
          documentLineId: part.id,
          createdBy: userId,
        },
        db,
      );
    }

    // Сторно боргу: сума з IN-TX re-read totalAmount (дзеркалить charge-логіку). COMPLETED поза
    // EDITABLE_STATUSES → totalAmount не змінюється, але re-read гарантує точну симетрію з CHARGE.
    const freshWo = await db.workOrder.findFirst({
      where: { id: wo.id, orgId },
      select: { totalAmount: true },
    });
    const creditAmount = roundMoney(Number(freshWo?.totalAmount ?? wo.totalAmount ?? 0));
    if (creditAmount > 0) {
      await this.settlements.createTransaction(
        orgId,
        {
          counterpartyId: wo.counterpartyId,
          type: 'CREDIT_NOTE',
          amount: creditAmount,
          documentType: 'WorkOrder',
          documentId: wo.id,
          createdBy: userId,
        },
        db,
      );
    }
  }

  private async fetchPartCoefficients(
    orgId: string,
    parts: { id: string; unitOfMeasureId?: string | null; goodId: string }[],
    db: Prisma.TransactionClient | typeof this.prisma,
  ): Promise<Record<string, number>> {
    const uomIds = parts.map(p => p.unitOfMeasureId).filter((id): id is string => !!id);
    if (uomIds.length === 0) return {};
    // WO-C2: WorkOrderPart.unitOfMeasureId — це FK на UnitOfMeasure.id (addPart зберігає
    // uomJunction.unitOfMeasureId), а НЕ GoodUoM.id (PK). Тож коефіцієнт беремо з GoodUoM за
    // парою (unitOfMeasureId, goodId) — унікальною у @@unique([orgId,goodId,unitOfMeasureId]).
    // Раніше lookup йшов по GoodUoM.id → мапа завжди порожня → coeff=1 → невірні кількості.
    // A1/A3: +orgId у where — GoodUoM tenant-scoped; без нього tenant-guard кидав би на transition
    // із UoM-запчастиною (500), а коефіцієнт міг би прийти з чужої org (крос-tenant).
    const goodIds = parts.map(p => p.goodId);
    const uoms = await (db as typeof this.prisma).goodUoM.findMany({
      where: { orgId, unitOfMeasureId: { in: uomIds }, goodId: { in: goodIds } },
      select: { unitOfMeasureId: true, goodId: true, coefficient: true },
    });
    // Ключ = goodId|unitOfMeasureId (коефіцієнт специфічний для товару).
    const coeffByGoodUom = new Map<string, number>(
      uoms.map(u => [`${u.goodId}|${u.unitOfMeasureId}`, u.coefficient]),
    );
    const result: Record<string, number> = {};
    for (const part of parts) {
      if (part.unitOfMeasureId) {
        // DTO @Min(0.000001) blocks coefficient=0 on write-path, but legacy/seed/direct-SQL
        // data may have 0. safeCoeff() handles 0/NaN/negative/undefined → 1.
        result[part.id] = safeCoeff(coeffByGoodUom.get(`${part.goodId}|${part.unitOfMeasureId}`));
      }
    }
    return result;
  }
}
