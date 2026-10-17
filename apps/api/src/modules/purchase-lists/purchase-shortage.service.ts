import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  fetchPartCoefficients,
  netReservedByWorkOrders,
  partBaseQty,
  QTY_EPSILON,
  stockKey,
} from '../work-orders/work-order-stock-requirements';
import { PROCUREMENT_ACTIVE_STATUSES } from '../work-orders/work-orders.fsm';
import { undelivered } from './purchase-list-link.service';
import type { ShortageResponseDto, ShortageRowDto } from './purchase-lists.dto';

type Db = Prisma.TransactionClient;

/** Межа рядків товарів нарядів, які читає один розрахунок нестачі. */
const MAX_PARTS = 5000;

const PART_INCLUDE = {
  workOrder: { select: { number: true, status: true, plannedAt: true, createdAt: true } },
  good: { select: { name: true, sku: true, unit: true, preferredSupplierId: true } },
  warehouse: { select: { name: true } },
} as const satisfies Prisma.WorkOrderPartInclude;

type PartRow = Prisma.WorkOrderPartGetPayload<{ include: typeof PART_INCLUDE }>;

export interface ShortageScope {
  /** Лише ці товари (усі наряди, що їх потребують, — пул складу ділиться FIFO між ними). */
  goodIds?: string[];
  warehouseId?: string;
}

interface ComputedShortage {
  rows: ShortageRowDto[];
  truncated: boolean;
}

/**
 * Нестача товарів нарядів (BR-PL-014). Для кожного рядка товару невидаленого наряду в
 * WO_PROCUREMENT_ACTIVE_STATUSES: `потреба = кількість × коефіцієнт`, покрита
 *   1) резервом наряду (net за товаром і складом ділиться між рядками наряду FIFO),
 *   2) позиціями списків саме цього рядка (OPEN + недоотримане ORDERED),
 *   3) пулом складу — вільний залишок + ручні позиції (OPEN + недоотримане ORDERED) — FIFO між
 *      нарядами за `plannedAt ?? createdAt`.
 * Та сама непокрита потреба — кількість за замовчуванням у «До списку купівлі» (BR-PL-003).
 *
 * Запити: рядки нарядів (з нарядом, товаром і складом), потім паралельно коефіцієнти одиниць,
 * net-резерви нарядів (`groupBy`), позиції списків і рядки складу — без N+1.
 */
@Injectable()
export class PurchaseShortageService {
  constructor(private readonly prisma: PrismaService) {}

  async shortage(
    orgId: string,
    query: { warehouseId?: string; workOrderId?: string; limit: number },
  ): Promise<ShortageResponseDto> {
    let scope: ShortageScope = { warehouseId: query.warehouseId };
    if (query.workOrderId) {
      // Нестача одного наряду рахується серед УСІХ нарядів із тими самими товарами: пул складу
      // ділиться між ними FIFO, і наряд, запланований раніше, бере свою частку першим.
      const own = await this.prisma.workOrderPart.findMany({
        where: { orgId, workOrderId: query.workOrderId, deletedAt: null },
        select: { goodId: true },
        take: 1000,
      });
      scope = { ...scope, goodIds: Array.from(new Set(own.map(p => p.goodId))) };
      if (scope.goodIds?.length === 0) return { items: [], truncated: false };
    }
    const computed = await this.compute(this.prisma, orgId, scope);
    const rows = query.workOrderId
      ? computed.rows.filter(r => r.workOrderId === query.workOrderId)
      : computed.rows;
    return {
      items: rows.slice(0, query.limit),
      truncated: computed.truncated || rows.length > query.limit,
    };
  }

  /** Непокрита потреба кожного рядка товару наряду (`workOrderPartId → кількість`). */
  async uncoveredByPart(db: Db, orgId: string, workOrderId: string): Promise<Map<string, number>> {
    const rows = await this.uncoveredRowsByPart(db, orgId, workOrderId);
    return new Map(Array.from(rows, ([partId, row]) => [partId, row.shortage]));
  }

  /**
   * Рядки нестачі наряду (`workOrderPartId → рядок`): кількість — у БАЗОВИХ одиницях товару, тож
   * картка наряду підписує її `goodUnit`, а не одиницею рядка (Bug #886: «6 Пак» замість «6 шт»).
   */
  async uncoveredRowsByPart(
    db: Db,
    orgId: string,
    workOrderId: string,
  ): Promise<Map<string, ShortageRowDto>> {
    const own = await db.workOrderPart.findMany({
      where: { orgId, workOrderId, deletedAt: null },
      select: { goodId: true },
      take: 1000,
    });
    const result = new Map<string, ShortageRowDto>();
    if (own.length === 0) return result;
    const { rows } = await this.compute(db, orgId, {
      goodIds: Array.from(new Set(own.map(p => p.goodId))),
    });
    for (const r of rows) if (r.workOrderId === workOrderId) result.set(r.workOrderPartId, r);
    return result;
  }

  private async compute(db: Db, orgId: string, scope: ShortageScope): Promise<ComputedShortage> {
    const parts: PartRow[] = await db.workOrderPart.findMany({
      where: {
        orgId,
        deletedAt: null,
        ...(scope.goodIds ? { goodId: { in: scope.goodIds } } : {}),
        ...(scope.warehouseId ? { warehouseId: scope.warehouseId } : {}),
        workOrder: { deletedAt: null, status: { in: [...PROCUREMENT_ACTIVE_STATUSES] } },
      },
      include: PART_INCLUDE,
      orderBy: { createdAt: 'asc' },
      take: MAX_PARTS + 1,
    });
    const truncated = parts.length > MAX_PARTS;
    if (truncated) parts.length = MAX_PARTS;
    if (parts.length === 0) return { rows: [], truncated };

    const woIds = Array.from(new Set(parts.map(p => p.workOrderId)));
    const goodIds = Array.from(new Set(parts.map(p => p.goodId)));
    const [coeffMap, net, items, stock] = await Promise.all([
      fetchPartCoefficients(db, orgId, parts),
      netReservedByWorkOrders(db, orgId, woIds),
      db.purchaseListItem.findMany({
        where: {
          orgId,
          deletedAt: null,
          goodId: { in: goodIds },
          status: { in: ['OPEN', 'ORDERED'] },
        },
        select: {
          workOrderId: true,
          workOrderPartId: true,
          goodId: true,
          warehouseId: true,
          quantity: true,
          receivedQty: true,
          status: true,
        },
        take: MAX_PARTS,
      }),
      db.stockItem.findMany({
        where: { orgId, deletedAt: null, goodId: { in: goodIds } },
        select: { goodId: true, warehouseId: true, quantity: true, reserved: true },
        take: MAX_PARTS,
      }),
    ]);

    // Покриття позиціями: позиції рядка наряду — йому; ручні — у спільний пул складу.
    const itemsByPart = new Map<string, number>();
    const pool = new Map<string, number>();
    for (const i of items) {
      const cover = i.status === 'OPEN' ? i.quantity : undelivered(i);
      if (i.workOrderPartId) {
        itemsByPart.set(i.workOrderPartId, (itemsByPart.get(i.workOrderPartId) ?? 0) + cover);
      } else if (!i.workOrderId) {
        const key = stockKey(i.goodId, i.warehouseId);
        pool.set(key, (pool.get(key) ?? 0) + cover);
      }
    }
    for (const s of stock) {
      const key = stockKey(s.goodId, s.warehouseId);
      pool.set(key, (pool.get(key) ?? 0) + Math.max(0, s.quantity - s.reserved));
    }

    // FIFO нарядів за `plannedAt ?? createdAt`; рядки наряду — за часом створення.
    const woTime = (p: PartRow) => (p.workOrder.plannedAt ?? p.workOrder.createdAt).getTime();
    const ordered = [...parts].sort(
      (a, b) =>
        woTime(a) - woTime(b) ||
        a.workOrderId.localeCompare(b.workOrderId) ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );

    const reserveLeft = new Map<string, number>(); // `${woId}|${key}` → залишок net-резерву
    const rows: ShortageRowDto[] = [];
    for (const part of ordered) {
      const key = stockKey(part.goodId, part.warehouseId);
      const reserveKey = `${part.workOrderId}|${key}`;
      if (!reserveLeft.has(reserveKey)) {
        reserveLeft.set(reserveKey, Math.max(0, net.get(part.workOrderId)?.get(key) ?? 0));
      }
      const required = partBaseQty(part, coeffMap);
      let need = required;

      const reserved = Math.min(need, reserveLeft.get(reserveKey) ?? 0);
      reserveLeft.set(reserveKey, (reserveLeft.get(reserveKey) ?? 0) - reserved);
      need -= reserved;

      const inLists = Math.min(need, itemsByPart.get(part.id) ?? 0);
      need -= inLists;

      const fromPool = Math.min(need, pool.get(key) ?? 0);
      pool.set(key, (pool.get(key) ?? 0) - fromPool);
      need -= fromPool;

      if (need <= QTY_EPSILON) continue;
      rows.push({
        workOrderId: part.workOrderId,
        workOrderNumber: part.workOrder.number,
        workOrderStatus: part.workOrder.status,
        plannedAt: part.workOrder.plannedAt ? part.workOrder.plannedAt.toISOString() : null,
        workOrderPartId: part.id,
        goodId: part.goodId,
        goodName: part.good.name,
        goodSku: part.good.sku ?? null,
        goodUnit: part.good.unit ?? null,
        warehouseId: part.warehouseId,
        warehouseName: part.warehouse.name,
        required,
        reserved,
        inLists,
        fromPool,
        shortage: need,
        preferredSupplierId: part.good.preferredSupplierId ?? null,
      });
    }
    return { rows, truncated };
  }
}
