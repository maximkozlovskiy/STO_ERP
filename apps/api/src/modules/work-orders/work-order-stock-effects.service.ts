import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { translateError } from '@sto/shared';
import { safeCoeff } from '../../common/utils/math';
import { moneyFromDecimal } from '../../common/utils/money';
import { getLocale } from '../../common/tenant/tenant-context';
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
    // Batch-fetch GoodUoM coefficients for qty conversion: qty_base = qty * coefficient
    // (coefficient = скільки БАЗОВИХ одиниць в одній альтернативній: «1 пакет = 12 шт» → 12).
    const coeffMap = await this.fetchPartCoefficients(orgId, parts, db);

    for (const part of parts) {
      const coeff = coeffMap[part.id] ?? 1;
      await this.inventory.createMovement(
        orgId,
        {
          goodId: part.goodId,
          warehouseId: part.warehouseId,
          type: 'RESERVATION',
          quantity: part.quantity * coeff,
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

    // Bug #780: цей наряд міг НЕ резервувати (шлях APPROVED→ON_HOLD→CANCELLED: reserveParts
    // ставить резерв лише на APPROVED→IN_PROGRESS). Тоді безумовний RESERVATION_RELEASE(-q)
    // кидав би "cannotReleaseMoreThanReserved" → скасувати наряд неможливо; або звільняв би
    // чужий резерв. Звільняємо РІВНО свій нетто-резерв по (good,warehouse).
    const reservedByGood = await this.netReservedByWorkOrder(orgId, workOrderId, db);

    for (const part of parts) {
      const coeff = coeffMap[part.id] ?? 1;
      const baseQty = part.quantity * coeff;
      const rkey = `${part.goodId}|${part.warehouseId}`;
      const heldReserve = reservedByGood.get(rkey) ?? 0;
      const releaseQty = Math.min(baseQty, Math.max(0, heldReserve));
      if (releaseQty <= 0) continue;
      reservedByGood.set(rkey, heldReserve - releaseQty);
      await this.inventory.createMovement(
        orgId,
        {
          goodId: part.goodId,
          warehouseId: part.warehouseId,
          type: 'RESERVATION_RELEASE',
          quantity: -releaseQty,
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

    // Bug #780: цей наряд резервує ЛИШЕ на APPROVED→IN_PROGRESS (reserveParts). Шлях
    // APPROVED→ON_HOLD→IN_PROGRESS→COMPLETED НЕ резервує (guard reserveParts вимагає
    // попередній статус APPROVED), тож на COMPLETED резерву цього наряду НЕМА. Безумовний
    // RESERVATION_RELEASE(-baseQty) тоді: (а) якщо reserved===0 → InventoryService кидає
    // "cannotReleaseMoreThanReserved" → весь перехід COMPLETED падає (наряд неможливо
    // завершити); (б) якщо резерв тримає ІНШИЙ наряд → ми звільняємо ЧУЖИЙ резерв →
    // псування лічильника reserved (фантомна доступність). reserved — агрегат на StockItem,
    // не per-document, тож скільки саме тримає ЦЕЙ наряд рахуємо з його RESERVATION-рухів.
    const reservedByGood = await this.netReservedByWorkOrder(orgId, wo.id, db);

    for (const part of parts) {
      const coeff = coeffMap[part.id] ?? 1;
      const baseQty = part.quantity * coeff;
      // Logic-bug fix: release the reservation BEFORE writeoff. InventoryService.createMovement
      // gates WRITEOFF on `available = quantity - reserved >= |qty|`. Якщо весь фізичний
      // залишок зарезервовано саме цим нарядом (квантитет = резерв = baseQty), available=0
      // і WRITEOFF падає з "Недостатньо товару на складі" попри те, що фізичні запчастини
      // на складі присутні. Послідовність RELEASE → WRITEOFF: спочатку звільняємо резерв
      // (reserved -= baseQty), потім списуємо (тепер available = quantity > 0).
      //
      // Bug #780: звільняємо РІВНО стільки, скільки цей наряд реально тримає у резерві для
      // (good,warehouse) — min(baseQty, залишок резерву наряду). 0 → RESERVATION_RELEASE
      // пропускаємо (ON_HOLD-шлях нічого не резервував). Так WRITEOFF усе одно проходить:
      // available не включає фантомного резерву цього наряду.
      const rkey = `${part.goodId}|${part.warehouseId}`;
      const heldReserve = reservedByGood.get(rkey) ?? 0;
      const releaseQty = Math.min(baseQty, Math.max(0, heldReserve));
      if (releaseQty > 0) {
        reservedByGood.set(rkey, heldReserve - releaseQty);
        await this.inventory.createMovement(
          orgId,
          {
            goodId: part.goodId,
            warehouseId: part.warehouseId,
            type: 'RESERVATION_RELEASE',
            quantity: -releaseQty,
            documentType: 'WorkOrder',
            documentId: wo.id,
            createdBy: userId,
          },
          db,
        );
      }
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
      // Мультивалюта (Фаза 3): валюта + дата документа для base-конвертації CHARGE.
      select: { totalAmount: true, currencyId: true, documentDate: true },
    });
    const chargeAmount = moneyFromDecimal(freshWo?.totalAmount ?? wo.totalAmount);
    if (chargeAmount <= 0)
      throw new BadRequestException(
        translateError('err.workOrder.totalZeroCannotComplete', getLocale()),
      );
    await this.settlements.createTransaction(
      orgId,
      {
        counterpartyId: wo.counterpartyId,
        type: 'CHARGE',
        amount: chargeAmount,
        // Борг у base по курсу на дату документа (наряд ведеться у валюті). Без currencyId → base.
        currencyId: freshWo?.currencyId ?? undefined,
        date: freshWo?.documentDate ?? undefined,
        fallbackToLatest: true,
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
      const baseQty = part.quantity * coeff;
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
      // Мультивалюта (Фаза 3): валюта + дата документа для симетрії CREDIT_NOTE з CHARGE.
      select: { totalAmount: true, currencyId: true, documentDate: true },
    });
    const creditAmount = moneyFromDecimal(freshWo?.totalAmount ?? wo.totalAmount);
    if (creditAmount > 0) {
      await this.settlements.createTransaction(
        orgId,
        {
          counterpartyId: wo.counterpartyId,
          type: 'CREDIT_NOTE',
          amount: creditAmount,
          currencyId: freshWo?.currencyId ?? undefined,
          date: freshWo?.documentDate ?? undefined,
          fallbackToLatest: true,
          documentType: 'WorkOrder',
          documentId: wo.id,
          createdBy: userId,
        },
        db,
      );
    }
  }

  /**
   * Bug #780: нетто-резерв, який ЦЕЙ наряд реально тримає на складі, по (goodId|warehouseId).
   * reserved на StockItem — агрегат (не per-document), тож per-наряд рахуємо з його власних
   * RESERVATION/RESERVATION_RELEASE-рухів: Σ(quantity) (RESERVATION >0, RESERVATION_RELEASE <0).
   * Використовується у writeOffPartsAndCharge щоб звільняти РІВНО свій резерв (не чужий і не
   * фантомний на ON_HOLD-шляху, де резерву взагалі не було).
   */
  private async netReservedByWorkOrder(
    orgId: string,
    workOrderId: string,
    db: Prisma.TransactionClient | typeof this.prisma,
  ): Promise<Map<string, number>> {
    const movements = await (db as typeof this.prisma).stockMovement.findMany({
      where: {
        orgId,
        documentType: 'WorkOrder',
        documentId: workOrderId,
        type: { in: ['RESERVATION', 'RESERVATION_RELEASE'] },
      },
      select: { goodId: true, warehouseId: true, quantity: true },
      take: 5000,
    });
    const net = new Map<string, number>();
    for (const m of movements) {
      const key = `${m.goodId}|${m.warehouseId}`;
      net.set(key, (net.get(key) ?? 0) + m.quantity);
    }
    return net;
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
