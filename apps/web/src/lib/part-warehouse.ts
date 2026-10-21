/**
 * Склад рядка товару наряду (BR-WO-029, рішення власника 2026-10-21).
 *
 * Вільна кількість — `available = quantity − reserved` з `GET /goods/stock-totals` (не менше нуля).
 * Склад, що підставляється, щойно обрано товар:
 *  1. вільна є лише на одному складі → цей склад;
 *  2. на кількох → основний (`isMain`), якщо вільна є на ньому;
 *  3. на кількох, але не на основному → '' (обирає людина);
 *  4. вільної немає ніде → основний склад ('' — якщо основного в переліку немає).
 * Рахуються лише склади з переліку вибору (без видалених і «Шинного готелю»): залишок на складі
 * поза переліком не підставиться, бо його не можна обрати.
 */

/** Вільна кількість товару на одному складі. */
export interface WarehouseFree {
  warehouseId: string;
  available: number;
}

/** Склад переліку вибору: лише те, що потрібно правилу. */
export interface PickableWarehouse {
  id: string;
  isMain?: boolean;
}

/** Склад потрапляє в перелік вибору рядка товару: не видалений і не «Шинний готель». */
export const isPartWarehouse = (w: { type?: string; deletedAt?: string | null }): boolean =>
  !w.deletedAt && w.type !== 'TIRE_HOTEL';

/** Рядок складу з відповіді `stock-totals`; `reserved` / `available` може не бути у старої збірки API. */
export interface StockByWarehouseRow {
  warehouseId: string;
  quantity: number;
  reserved?: number;
  available?: number;
}

/** Вільна кількість рядка складу; відповідь без `available` — з `quantity − reserved`. */
export function freeOf(row: StockByWarehouseRow): number {
  const free = row.available ?? Number(row.quantity) - Number(row.reserved ?? 0);
  return Number.isFinite(free) ? Math.max(0, free) : 0;
}

export function pickPartWarehouse(
  byWarehouse: readonly WarehouseFree[],
  warehouses: readonly PickableWarehouse[],
): string {
  const listed = new Set(warehouses.map(w => w.id));
  const withFree = new Set(
    byWarehouse.filter(w => listed.has(w.warehouseId) && w.available > 0).map(w => w.warehouseId),
  );
  const mainId = warehouses.find(w => w.isMain)?.id ?? '';
  if (withFree.size === 1) return [...withFree][0];
  if (withFree.size > 1) return mainId && withFree.has(mainId) ? mainId : '';
  return mainId;
}
