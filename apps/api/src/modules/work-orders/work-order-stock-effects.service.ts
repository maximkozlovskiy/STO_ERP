import { Injectable, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { translateError } from '@sto/shared';
import { moneyFromDecimal } from '../../common/utils/money';
import { getLocale } from '../../common/tenant/tenant-context';
import { PrismaService } from '../../prisma/prisma.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from '../settlements/settlements.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { postWorkOrderFxInTx } from './work-order-fx';
import { PurchaseListLinkService } from '../purchase-lists/purchase-list-link.service';
import {
  availableQty,
  fetchPartCoefficients,
  netReservedByWorkOrder,
  QTY_EPSILON,
  requiredByKey,
  splitStockKey,
  stockKey,
} from './work-order-stock-requirements';

/**
 * Bug #780: списує з нетто-резерву наряду не більше ніж `want`, повертає СКІЛЬКИ реально взято
 * і зменшує залишок у мапі. Мутація мапи критична: кілька рядків наряду можуть вказувати на той
 * самий (good,warehouse), і без декременту другий рядок звільнив би той самий резерв удруге.
 *
 * Використовується у writeOffPartsAndCharge: на 0 RELEASE пропускається, а WRITEOFF лишається.
 */
function takeFromReserve(
  reserveByStock: Map<string, number>,
  goodId: string,
  warehouseId: string,
  want: number,
): number {
  const key = stockKey(goodId, warehouseId);
  const held = reserveByStock.get(key) ?? 0;
  // Math.max(0, …): нетто може бути від'ємним на зіпсованих історичних даних (RELEASE без
  // парного RESERVATION) — тоді беремо 0, а не від'ємну «кількість».
  const taken = Math.min(want, Math.max(0, held));
  if (taken > 0) reserveByStock.set(key, held - taken);
  return taken;
}

/**
 * A3 (розбиття God-об'єктів): transaction-critical stock+settlement side-effects FSM-переходів наряду —
 * окремий bounded context (склад+баланс), винесений з WorkOrdersService.transition. Резерв/списання/
 * повернення запчастин (через InventoryService.createMovement) + борг/сторно (через
 * SettlementsService.createTransaction). Усі методи приймають `tx` і викликаються ВСЕРЕДИНІ
 * transition-$transaction — ефекти атомарні зі зміною статусу.
 *
 * ⚠️ Уся логіка перенесена ДОСЛІВНО з WorkOrdersService (behavior-identical), окрім однієї виправленої
 * латентної помилки: fetchPartCoefficients тепер фільтрує GoodUoM за orgId (tenant-isolation).
 * Потреба й net-резерв наряду — у work-order-stock-requirements.ts (спільні зі списками купівлі).
 */
@Injectable()
export class WorkOrderStockEffectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly settlements: SettlementsService,
    // BR-PAY-022: курсова різниця наряду, сплаченого повністю авансом, — при нарахуванні боргу.
    private readonly exchangeRates: ExchangeRatesService,
    // BR-PL-013: позиції списків купівлі наряду реагують на його скасування, видалення, завершення
    // й зміну товарів — у транзакції наряду.
    private readonly purchaseLists: PurchaseListLinkService,
  ) {}

  /**
   * BR-PAY-022: курсова різниця наряду в іноземній валюті, якщо він уже сплачений повністю (аванс)
   * і борг щойно нараховано. Викликати в транзакції переходу ПІСЛЯ `writeOffPartsAndCharge`.
   */
  async postFxIfSettled(
    orgId: string,
    workOrderId: string,
    userId: string | undefined,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await postWorkOrderFxInTx(
      tx,
      { settlements: this.settlements, exchangeRates: this.exchangeRates },
      orgId,
      workOrderId,
      userId,
    );
  }

  /**
   * BR-WO-021: «В роботу» дорезервовує лише бракуюче — `потрібно − net-резерв наряду` по (товар,
   * склад), не більше `available`. Нестача не блокує перехід (рішення власника 2026-10-17): решту
   * дорезервує приймання від постачальника (BR-PL-011). Ідемпотентний: повторний вхід у «В роботі»
   * (з «Призупинено») подвійного резерву не дає — net уже покриває потребу.
   */
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
    const coeffMap = await fetchPartCoefficients(db, orgId, parts);
    const required = requiredByKey(parts, coeffMap);
    const net = await netReservedByWorkOrder(db, orgId, workOrderId);

    // Ключі в стабільному порядку — рядки складу блокуються (upsert у createMovement) в одному
    // порядку в усіх переходах, а не в порядку рядків наряду.
    for (const key of Array.from(required.keys()).sort()) {
      const want = (required.get(key) ?? 0) - Math.max(0, net.get(key) ?? 0);
      if (want <= QTY_EPSILON) continue;
      const [goodId, warehouseId] = splitStockKey(key);
      const available = await availableQty(db, orgId, goodId, warehouseId);
      const take = Math.min(want, available);
      if (take <= QTY_EPSILON) continue;
      await this.inventory.createMovement(
        orgId,
        {
          goodId,
          warehouseId,
          type: 'RESERVATION',
          quantity: take,
          documentType: 'WorkOrder',
          documentId: workOrderId,
          createdBy: userId,
        },
        db,
      );
    }
  }

  /**
   * BR-WO-021: знімає ВЕСЬ net-резерв наряду за картою його рухів (BR-INVT-018), а не за рядками
   * товарів — резерв міг лишитись за рядком, якого вже немає, і бути зроблений у будь-якому
   * активному статусі (приймання від постачальника, BR-PL-011). Скасування з будь-якого статусу,
   * крім COMPLETED (там резерв знято списанням), і видалення наряду.
   */
  async releaseAllNetReservations(
    orgId: string,
    workOrderId: string,
    userId?: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;
    const net = await netReservedByWorkOrder(db, orgId, workOrderId);
    await this.releaseExcess(orgId, workOrderId, net, new Map(), userId, db);
    // BR-PL-013: наряд скасовано чи видалено — його незамовлені позиції списків скасовуються,
    // а `reservedQty` позицій обнуляється слідом за знятим резервом.
    await this.purchaseLists.onWorkOrderClosed(db, orgId, workOrderId, { reserveReleased: true });
  }

  /**
   * BR-WO-021: після зміни товарів наряду (кількість, одиниця, видалення рядка, імпорт XLSX) знімає
   * надлишок net-резерву над потребою по кожній парі (товар, склад). Викликати в транзакції правки,
   * ПІСЛЯ запису рядків.
   */
  async reconcileAfterPartsChange(
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
    const coeffMap = await fetchPartCoefficients(db, orgId, parts);
    const required = requiredByKey(parts, coeffMap);
    const net = await netReservedByWorkOrder(db, orgId, workOrderId);
    await this.releaseExcess(orgId, workOrderId, net, required, userId, db);
    // BR-PL-013: надлишок покриття знімається з OPEN-позицій наряду (після зняття резерву).
    // Потреба — та сама, що вище (рядки в цій транзакції не змінювались): хук її не перечитує.
    await this.purchaseLists.onWorkOrderPartsChanged(db, orgId, workOrderId, required);
  }

  /**
   * RESERVATION_RELEASE на `net − keep` по кожній парі, де net-резерв наряду перевищує те, що треба
   * лишити. Не більше `StockItem.reserved`: на зіпсованих історичних даних net наряду може бути
   * більшим за агрегат складу, і безумовне зняття впало б «cannotReleaseMoreThanReserved».
   */
  private async releaseExcess(
    orgId: string,
    workOrderId: string,
    net: Map<string, number>,
    keep: Map<string, number>,
    userId: string | undefined,
    db: Prisma.TransactionClient,
  ): Promise<void> {
    for (const key of Array.from(net.keys()).sort()) {
      const excess = (net.get(key) ?? 0) - (keep.get(key) ?? 0);
      if (excess <= QTY_EPSILON) continue;
      const [goodId, warehouseId] = splitStockKey(key);
      const item = await db.stockItem.findFirst({
        where: { orgId, goodId, warehouseId, deletedAt: null },
        select: { reserved: true },
      });
      const release = Math.min(excess, item?.reserved ?? 0);
      if (release <= QTY_EPSILON) continue;
      await this.inventory.createMovement(
        orgId,
        {
          goodId,
          warehouseId,
          type: 'RESERVATION_RELEASE',
          quantity: -release,
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
    const coeffMap = await fetchPartCoefficients(db, orgId, parts);

    // Bug #780: резерв наряду може бути меншим за потребу (нестача на «В роботу», BR-WO-021) або
    // його може не бути зовсім. Безумовний RESERVATION_RELEASE(-baseQty) тоді: (а) reserved===0 →
    // "cannotReleaseMoreThanReserved" → наряд неможливо завершити; (б) резерв тримає ІНШИЙ наряд →
    // звільнили б ЧУЖИЙ резерв. reserved — агрегат на StockItem, не per-document, тож скільки саме
    // тримає ЦЕЙ наряд рахуємо з його RESERVATION-рухів.
    const reserveByStock = await netReservedByWorkOrder(db, orgId, wo.id);

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
      // пропускаємо (резерву не було), але WRITEOFF нижче ВСЕ ОДНО робимо: available не включає
      // фантомного резерву цього наряду.
      const releaseQty = takeFromReserve(reserveByStock, part.goodId, part.warehouseId, baseQty);
      if (releaseQty > 0) {
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
    // BR-WO-021: залишок net-резерву після списання рядків (резерв за рядком, якого вже немає, чи
    // за одиницею, що змінилась) знімається — інакше «завис» би на складі назавжди.
    await this.releaseExcess(orgId, wo.id, reserveByStock, new Map(), userId, db);
    // BR-PL-013: наряд завершено — незамовлені позиції списків купівлі вже не потрібні.
    await this.purchaseLists.onWorkOrderClosed(db, orgId, wo.id);
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
    const coeffMap = await fetchPartCoefficients(db, orgId, parts);

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
}
