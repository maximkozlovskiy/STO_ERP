import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma, PurchaseListItem } from '@prisma/client';
import { groupBy } from '../../common/utils/array';
import { err } from '../../common/utils/err';
import { InventoryService } from '../inventory/inventory.service';
import {
  fetchPartCoefficients,
  freeQty,
  lockWorkOrdersForUpdate,
  netReservedByWorkOrders,
  QTY_EPSILON,
  requiredByKey,
  stockKey,
  stockLevels,
} from '../work-orders/work-order-stock-requirements';
import { PROCUREMENT_ACTIVE_STATUSES } from '../work-orders/work-orders.fsm';
import { undelivered } from './purchase-list-link.service';

type Tx = Prisma.TransactionClient;

/**
 * Порядок, у якому отримане розподіляється між ORDERED-позиціями одного товару (BR-PL-011).
 * Етап 1 — FIFO за часом створення позиції; етап 3 (розподіл за стратегією «швидко / дешево /
 * оптимально») підставить іншу реалізацію.
 */
export interface AllocationStrategy {
  order(items: PurchaseListItem[]): PurchaseListItem[];
}

export const FIFO_ALLOCATION: AllocationStrategy = {
  order: items => [...items].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
};

/** Отримане одним прийманням: товар і кількість (базові одиниці). */
export interface ReceivedGood {
  goodId: string;
  quantity: number;
}

/**
 * Розподіл товару, отриманого від постачальника, між позиціями списків купівлі й резерв під їхні
 * наряди (BR-PL-011, BR-INVT-018). Викликається з `PurchaseOrdersService.receive` у ТІЙ САМІЙ
 * транзакції: `lockCandidateWorkOrders` — ДО змін залишку (порядок блокувань «наряд → склад»),
 * `allocateOnReceipt` — після руху RECEIPT і до боргу постачальнику.
 */
@Injectable()
export class PurchaseListReceiptService {
  private readonly strategy: AllocationStrategy = FIFO_ALLOCATION;

  constructor(private readonly inventory: InventoryService) {}

  /** Блокує наряди ORDERED-позицій цього замовлення за товарами приймання (FOR UPDATE, за id). */
  async lockCandidateWorkOrders(
    tx: Tx,
    orgId: string,
    purchaseOrderId: string,
    goodIds: string[],
  ): Promise<void> {
    if (goodIds.length === 0) return;
    const items = await tx.purchaseListItem.findMany({
      where: {
        orgId,
        purchaseOrderId,
        goodId: { in: goodIds },
        status: 'ORDERED',
        deletedAt: null,
        workOrderId: { not: null },
      },
      select: { workOrderId: true },
      take: 1000,
    });
    const ids = items.map(i => i.workOrderId).filter((id): id is string => id !== null);
    await lockWorkOrdersForUpdate(tx, orgId, ids);
  }

  /**
   * BR-PL-011: кожна ORDERED-позиція замовлення за товаром (на складі замовлення, порядок —
   * стратегія) отримує `min(залишок отриманого, недоотримане позиції)`; під її наряд резервується
   * `min(отримане позицією, непокрита потреба наряду, available)` — лише для невидаленого наряду в
   * WO_PROCUREMENT_ACTIVE_STATUSES. Решта лишається вільним залишком; брак `available` приймання
   * не зриває (резерв просто менший). Рядок складу заблоковано рухом RECEIPT цієї транзакції, тож
   * прочитаний `available` не зміниться до коміту.
   */
  async allocateOnReceipt(
    tx: Tx,
    orgId: string,
    po: { id: string; warehouseId: string },
    received: ReceivedGood[],
    userId?: string,
  ): Promise<void> {
    const receivedByGood = new Map<string, number>();
    for (const r of received) {
      if (r.quantity > QTY_EPSILON)
        receivedByGood.set(r.goodId, (receivedByGood.get(r.goodId) ?? 0) + r.quantity);
    }
    if (receivedByGood.size === 0) return;

    const items = await tx.purchaseListItem.findMany({
      where: {
        orgId,
        purchaseOrderId: po.id,
        goodId: { in: Array.from(receivedByGood.keys()) },
        warehouseId: po.warehouseId,
        status: 'ORDERED',
        deletedAt: null,
      },
      take: 1000,
    });
    if (items.length === 0) return;

    const need = await this.openNeedByWorkOrder(tx, orgId, items);
    // Вільний залишок товарів приймання на складі замовлення — один запит до циклу; далі він
    // зменшується на кожен зроблений тут резерв (інших змін рядка складу в циклі немає).
    const available = new Map<string, number>();
    if (need.size > 0) {
      const keys = Array.from(receivedByGood.keys(), goodId => stockKey(goodId, po.warehouseId));
      const stock = await stockLevels(tx, orgId, keys);
      for (const key of keys) available.set(key, freeQty(stock.get(key)));
    }
    const itemsByGood = groupBy(items, i => i.goodId);

    for (const [goodId, qty] of receivedByGood) {
      let remaining = qty;
      const key = stockKey(goodId, po.warehouseId);
      for (const item of this.strategy.order(itemsByGood.get(goodId) ?? [])) {
        if (remaining <= QTY_EPSILON) break;
        const take = Math.min(remaining, undelivered(item));
        if (take <= QTY_EPSILON) continue;
        remaining -= take;

        const woNeed = item.workOrderId ? need.get(item.workOrderId) : undefined;
        let reserve = 0;
        if (woNeed) {
          const open = woNeed.get(key) ?? 0;
          const free = available.get(key) ?? 0;
          reserve = Math.max(0, Math.min(take, open, free));
          if (reserve > QTY_EPSILON) {
            woNeed.set(key, open - reserve);
            available.set(key, free - reserve);
          } else reserve = 0;
        }

        const receivedQty = item.receivedQty + take;
        const res = await tx.purchaseListItem.updateMany({
          where: {
            id: item.id,
            orgId,
            status: 'ORDERED',
            receivedQty: item.receivedQty,
            deletedAt: null,
          },
          data: {
            receivedQty,
            reservedQty: { increment: reserve },
            ...(item.quantity - receivedQty <= QTY_EPSILON ? { status: 'RECEIVED' as const } : {}),
          },
        });
        if (res.count !== 1) {
          throw new ConflictException(err('err.purchaseList.allocationConflict'));
        }
        if (reserve > 0 && item.workOrderId) {
          await this.inventory.createMovement(
            orgId,
            {
              goodId,
              warehouseId: po.warehouseId,
              type: 'RESERVATION',
              quantity: reserve,
              documentType: 'WorkOrder',
              documentId: item.workOrderId,
              notes: 'Резерв отриманого від постачальника (список купівлі)',
              createdBy: userId,
            },
            tx,
          );
        }
      }
    }
  }

  /**
   * Непокрита потреба активних нарядів позицій: `потрібно − net-резерв` по (товар, склад).
   * Наряд поза WO_PROCUREMENT_ACTIVE_STATUSES чи видалений — у мапі відсутній (не резервуємо).
   */
  private async openNeedByWorkOrder(
    tx: Tx,
    orgId: string,
    items: PurchaseListItem[],
  ): Promise<Map<string, Map<string, number>>> {
    const ids = Array.from(
      new Set(items.map(i => i.workOrderId).filter((id): id is string => id !== null)),
    );
    const result = new Map<string, Map<string, number>>();
    if (ids.length === 0) return result;
    const active = await tx.workOrder.findMany({
      where: {
        orgId,
        id: { in: ids },
        deletedAt: null,
        status: { in: [...PROCUREMENT_ACTIVE_STATUSES] },
      },
      select: { id: true },
    });
    const activeIds = active.map(w => w.id);
    if (activeIds.length === 0) return result;
    const [parts, net] = await Promise.all([
      tx.workOrderPart.findMany({
        where: { orgId, workOrderId: { in: activeIds }, deletedAt: null },
        take: 5000,
      }),
      netReservedByWorkOrders(tx, orgId, activeIds),
    ]);
    const coeffMap = await fetchPartCoefficients(tx, orgId, parts);
    const partsByWo = groupBy(parts, p => p.workOrderId);
    for (const woId of activeIds) {
      const required = requiredByKey(partsByWo.get(woId) ?? [], coeffMap);
      const woNet = net.get(woId) ?? new Map<string, number>();
      const open = new Map<string, number>();
      for (const [key, qty] of required) open.set(key, qty - Math.max(0, woNet.get(key) ?? 0));
      result.set(woId, open);
    }
    return result;
  }
}
