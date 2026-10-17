import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma, PurchaseListItem } from '@prisma/client';
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import {
  fetchPartCoefficients,
  netReservedByWorkOrder,
  QTY_EPSILON,
  requiredByKey,
  stockKey,
} from '../work-orders/work-order-stock-requirements';
import { PROCUREMENT_ACTIVE_STATUSES } from '../work-orders/work-orders.fsm';

type Tx = Prisma.TransactionClient;

/** Позиція в обсязі, потрібному хукам (усі поля таблиці, крім службових). */
type ItemRow = PurchaseListItem;

/** Скільки ще не отримано за ORDERED-позицією (базові одиниці). */
export const undelivered = (item: { quantity: number; receivedQty: number }): number =>
  Math.max(0, item.quantity - item.receivedQty);

/**
 * Хуки життєвого циклу позицій списків купівлі (BR-PL-009, 010, 012, 013): наряд і замовлення
 * постачальнику повідомляють сюди про свої зміни В СВОЇЙ транзакції. Сервіс не знає ні про
 * WorkOrdersService, ні про PurchaseOrdersService — лише про таблиці (немає циклу модулів).
 *
 * Кожна зміна стану позиції — `updateMany` з умовою на поточний стан і перевіркою `count`
 * (BR-PL-005): позицію змінили паралельно → 409 і відкат усієї транзакції виклику.
 */
@Injectable()
export class PurchaseListLinkService {
  /**
   * BR-PL-013: наряд скасовано, видалено або завершено — його OPEN-позиції → CANCELLED.
   * ORDERED не чіпаються: замовлення вже в постачальника, а отримане за ними не резервується
   * (наряд поза WO_PROCUREMENT_ACTIVE_STATUSES, BR-PL-011).
   */
  async onWorkOrderClosed(
    tx: Tx,
    orgId: string,
    workOrderId: string,
    opts: { reserveReleased?: boolean } = {},
  ): Promise<void> {
    await tx.purchaseListItem.updateMany({
      where: { orgId, workOrderId, status: 'OPEN', deletedAt: null },
      data: { status: 'CANCELLED' },
    });
    // Скасування й видалення зняли весь резерв наряду (BR-WO-021) — позиції не показують
    // «зарезервовано» того, чого вже немає. На COMPLETED резерв списано, а не знято: лишається.
    if (opts.reserveReleased) await this.capReservedToNet(tx, orgId, workOrderId);
  }

  /**
   * `reservedQty` позицій наряду не більший за його net-резерв по (товар, склад): після зняття
   * резерву (скасування, видалення, менша потреба — BR-WO-021) позиції зменшують `reservedQty`,
   * новіші першими. Інакше картка наряду показувала б «зарезервовано M», а «Зняти резерв»
   * (BR-PL-016) відповідав би 400 nothingToRelease.
   */
  async capReservedToNet(tx: Tx, orgId: string, workOrderId: string): Promise<void> {
    const items = await this.itemsOfWorkOrder(tx, orgId, workOrderId);
    if (!items.some(i => i.reservedQty > QTY_EPSILON)) return;
    const net = await netReservedByWorkOrder(tx, orgId, workOrderId);
    await this.capReserved(tx, orgId, items, net);
  }

  /** Усі невидалені позиції наряду, новіші першими (обидва хуки наряду читають саме їх). */
  private itemsOfWorkOrder(tx: Tx, orgId: string, workOrderId: string): Promise<ItemRow[]> {
    return tx.purchaseListItem.findMany({
      where: { orgId, workOrderId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
  }

  /** `reservedQty` позицій (новіші першими) урізається до net-резерву по (товар, склад). */
  private async capReserved(
    tx: Tx,
    orgId: string,
    items: ItemRow[],
    net: Map<string, number>,
  ): Promise<void> {
    const reserved = items.filter(i => i.reservedQty > QTY_EPSILON);
    const byKey = new Map<string, ItemRow[]>();
    for (const item of reserved) {
      const key = stockKey(item.goodId, item.warehouseId);
      byKey.set(key, [...(byKey.get(key) ?? []), item]);
    }
    for (const [key, group] of byKey) {
      let excess = group.reduce((s, i) => s + i.reservedQty, 0) - Math.max(0, net.get(key) ?? 0);
      for (const item of group) {
        if (excess <= QTY_EPSILON) break;
        const cut = Math.min(item.reservedQty, excess);
        const next = item.reservedQty - cut;
        const res = await tx.purchaseListItem.updateMany({
          where: { id: item.id, orgId, deletedAt: null, reservedQty: item.reservedQty },
          data: { reservedQty: next <= QTY_EPSILON ? 0 : next },
        });
        if (res.count !== 1) {
          throw new ConflictException(
            translateError('err.purchaseList.concurrentChange', getLocale()),
          );
        }
        excess -= cut;
      }
    }
  }

  /**
   * BR-PL-013: товари наряду змінено (менша кількість, інша одиниця, прибраний рядок, імпорт).
   * По кожній парі (товар, склад) покриття = net-резерв наряду + недоотримане ORDERED + OPEN;
   * надлишок над потребою знімається з OPEN-позицій, новіші першими (урізати або скасувати).
   * ORDERED не змінюються — при прийманні резерв обмежить потреба (BR-PL-011).
   * Викликати ПІСЛЯ зняття надлишку резерву (той самий tx).
   *
   * `required` — потреба наряду по (товар, склад), уже порахована викликом із рядків ЦІЄЇ
   * транзакції (reconcileAfterPartsChange): рядки між ним і хуком не змінюються, тож повторне
   * читання рядків і коефіцієнтів зайве. Без неї — читається тут.
   *
   * sto-optimize: позиції наряду читаються ОДИН раз (раніше — двічі: зріз резерву й урізання), а
   * net-резерв — один раз на обидва кроки (зріз `reservedQty` рухів не створює). Наряд без
   * позицій списків (більшість) — один запит.
   */
  async onWorkOrderPartsChanged(
    tx: Tx,
    orgId: string,
    workOrderId: string,
    required?: Map<string, number>,
  ): Promise<void> {
    const all = await this.itemsOfWorkOrder(tx, orgId, workOrderId);
    const hasReserved = all.some(i => i.reservedQty > QTY_EPSILON);
    // Новіші першими — порядок `all` (orderBy createdAt desc) зберігається фільтром.
    const items = all.filter(i => i.status === 'OPEN' || i.status === 'ORDERED');
    const hasOpen = items.some(i => i.status === 'OPEN');
    if (!hasReserved && !hasOpen) return;

    const net = await netReservedByWorkOrder(tx, orgId, workOrderId);
    // Надлишок резерву вже знято (reconcileAfterPartsChange) — reservedQty позицій слідом.
    if (hasReserved) await this.capReserved(tx, orgId, all, net);
    if (!hasOpen) return;

    const need = required ?? (await this.requiredOf(tx, orgId, workOrderId));
    const byKey = new Map<string, ItemRow[]>();
    for (const item of items) {
      const key = stockKey(item.goodId, item.warehouseId);
      byKey.set(key, [...(byKey.get(key) ?? []), item]);
    }
    for (const [key, group] of byKey) {
      const covered =
        Math.max(0, net.get(key) ?? 0) +
        group.reduce((s, i) => s + (i.status === 'OPEN' ? i.quantity : undelivered(i)), 0);
      let excess = covered - (need.get(key) ?? 0);
      // `group` уже від новіших до старіших (orderBy createdAt desc).
      for (const item of group) {
        if (excess <= QTY_EPSILON) break;
        if (item.status !== 'OPEN') continue;
        if (item.quantity <= excess + QTY_EPSILON) {
          await this.casItem(tx, orgId, item, { status: 'CANCELLED' });
          excess -= item.quantity;
        } else {
          await this.casItem(tx, orgId, item, { quantity: item.quantity - excess });
          excess = 0;
        }
      }
    }
  }

  /** Потреба наряду по (товар, склад) у базових одиницях — з його рядків у цій транзакції. */
  private async requiredOf(tx: Tx, orgId: string, workOrderId: string) {
    const parts = await tx.workOrderPart.findMany({
      where: { workOrderId, orgId, deletedAt: null },
      take: 1000,
    });
    return requiredByKey(parts, await fetchPartCoefficients(tx, orgId, parts));
  }

  /**
   * BR-PL-009: рядки DRAFT-замовлення переписано. Позиції замовлення звіряються за товаром:
   * товару в рядках немає → позиція повертається в OPEN; позицій більше, ніж замовлено, → новіші
   * відв'язуються (або розділяються: замовлене лишається ORDERED, решта — нова OPEN-позиція).
   */
  async reconcileDraftOrder(
    tx: Tx,
    orgId: string,
    purchaseOrderId: string,
    /** Склад замовлення після правки — передається, коли його могли змінити (PATCH). */
    warehouseId?: string,
  ): Promise<void> {
    const all = await tx.purchaseListItem.findMany({
      where: { orgId, purchaseOrderId, status: 'ORDERED', deletedAt: null },
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });
    if (all.length === 0) return;
    // Склад замовлення змінено: позиції іншого складу замовлення вже не покриває — приймання
    // розподіляє отримане лише між позиціями складу замовлення (BR-PL-011), тож вони
    // повертаються в OPEN, а не чекають товару, який прийде на інший склад.
    const items = warehouseId ? all.filter(i => i.warehouseId === warehouseId) : all;
    for (const item of all) {
      if (items.includes(item)) continue;
      await this.casItem(tx, orgId, item, { status: 'OPEN', purchaseOrderId: null });
    }
    if (items.length === 0) return;
    const lines = await tx.purchaseOrderLine.findMany({
      where: { orgId, purchaseOrderId, deletedAt: null },
      select: { goodId: true, quantity: true },
      take: 1000,
    });
    const orderedByGood = new Map<string, number>();
    for (const l of lines)
      orderedByGood.set(l.goodId, (orderedByGood.get(l.goodId) ?? 0) + l.quantity);

    const byGood = new Map<string, ItemRow[]>();
    for (const item of items) byGood.set(item.goodId, [...(byGood.get(item.goodId) ?? []), item]);
    for (const [goodId, group] of byGood) {
      // Старші позиції лишаються замовленими першими; новіші відв'язуються.
      let room = orderedByGood.get(goodId) ?? 0;
      for (const item of group) {
        if (item.quantity <= room + QTY_EPSILON) {
          room -= item.quantity;
        } else if (room > QTY_EPSILON) {
          await this.splitOff(tx, orgId, item, item.quantity - room, { status: 'OPEN' });
          room = 0;
        } else {
          await this.casItem(tx, orgId, item, { status: 'OPEN', purchaseOrderId: null });
        }
      }
    }
  }

  /**
   * BR-PL-010: замовлення видалено (DRAFT) чи скасовано. Позиція без жодної отриманої одиниці →
   * OPEN без замовлення; частково отримана → RECEIVED з `quantity = receivedQty` і нова позиція на
   * решту. Решта наряду, що вже закритий, не відкривається знову — нова позиція CANCELLED.
   */
  async onOrderCancelledOrDeleted(tx: Tx, orgId: string, purchaseOrderId: string): Promise<void> {
    await this.returnUndelivered(tx, orgId, purchaseOrderId);
  }

  /**
   * BR-PL-012: замовлення повністю прийняте (RECEIVED), а постачальник привіз менше, ніж у
   * позиціях: отримана частина → RECEIVED, на решту — нова OPEN-позиція з тими самими зв'язками.
   */
  async onOrderFullyReceived(tx: Tx, orgId: string, purchaseOrderId: string): Promise<void> {
    await this.returnUndelivered(tx, orgId, purchaseOrderId);
  }

  private async returnUndelivered(tx: Tx, orgId: string, purchaseOrderId: string): Promise<void> {
    const items = await tx.purchaseListItem.findMany({
      where: { orgId, purchaseOrderId, status: 'ORDERED', deletedAt: null },
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });
    if (items.length === 0) return;
    const activeWo = await this.activeWorkOrderIds(tx, orgId, items);
    for (const item of items) {
      const reopen = item.workOrderId === null || activeWo.has(item.workOrderId);
      const restStatus = reopen ? 'OPEN' : 'CANCELLED';
      if (item.receivedQty <= QTY_EPSILON) {
        await this.casItem(tx, orgId, item, { status: restStatus, purchaseOrderId: null });
      } else if (undelivered(item) <= QTY_EPSILON) {
        await this.casItem(tx, orgId, item, { status: 'RECEIVED' });
      } else {
        await this.splitOff(tx, orgId, item, undelivered(item), { status: restStatus });
      }
    }
  }

  /** Наряди позицій, що ще в WO_PROCUREMENT_ACTIVE_STATUSES і не видалені. */
  private async activeWorkOrderIds(tx: Tx, orgId: string, items: ItemRow[]): Promise<Set<string>> {
    const ids = Array.from(
      new Set(items.map(i => i.workOrderId).filter((id): id is string => id !== null)),
    );
    if (ids.length === 0) return new Set();
    const rows = await tx.workOrder.findMany({
      where: {
        orgId,
        id: { in: ids },
        deletedAt: null,
        status: { in: [...PROCUREMENT_ACTIVE_STATUSES] },
      },
      select: { id: true },
    });
    return new Set(rows.map(r => r.id));
  }

  /**
   * Відділяє `restQty` від ORDERED-позиції: вихідна лишається з рештою (`quantity − restQty`;
   * повністю отримана → RECEIVED), нова позиція з тими самими зв'язками, без замовлення й
   * отриманого, — у статусі `rest.status`.
   */
  private async splitOff(
    tx: Tx,
    orgId: string,
    item: ItemRow,
    restQty: number,
    rest: { status: 'OPEN' | 'CANCELLED' },
  ): Promise<void> {
    const keepQty = item.quantity - restQty;
    const keepStatus = keepQty - item.receivedQty <= QTY_EPSILON ? 'RECEIVED' : item.status;
    await this.casItem(tx, orgId, item, { quantity: keepQty, status: keepStatus });
    await tx.purchaseListItem.create({
      data: {
        orgId,
        listId: item.listId,
        goodId: item.goodId,
        warehouseId: item.warehouseId,
        quantity: restQty,
        status: rest.status,
        source: item.source,
        workOrderId: item.workOrderId,
        workOrderPartId: item.workOrderPartId,
        supplierId: item.supplierId,
        expectedPrice: item.expectedPrice,
        notes: item.notes,
      },
    });
  }

  /** Зміна позиції за умовою «стан не змінився» (BR-PL-005); інакше 409 і відкат. */
  private async casItem(
    tx: Tx,
    orgId: string,
    item: ItemRow,
    data: Prisma.PurchaseListItemUncheckedUpdateManyInput,
  ): Promise<void> {
    const res = await tx.purchaseListItem.updateMany({
      where: {
        id: item.id,
        orgId,
        deletedAt: null,
        status: item.status,
        quantity: item.quantity,
        receivedQty: item.receivedQty,
      },
      data,
    });
    if (res.count !== 1) {
      throw new ConflictException(translateError('err.purchaseList.concurrentChange', getLocale()));
    }
  }
}
