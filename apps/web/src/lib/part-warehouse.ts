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
  /** Філія складу — для запчастин із послуги (BR-WO-038). */
  branchId?: string;
  /** `WarehouseType`: MAIN / WORKSHOP / MOBILE (TIRE_HOTEL у перелік вибору не потрапляє). */
  type?: string;
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

/**
 * Вільна кількість рядка складу; відповідь без `available` — з `quantity − reserved`.
 * Округлено до 3 знаків, як `fmtQty`: залишок — сума Float по рухах (Bug #841), і без округлення
 * дрейф `2.3000000000000003 − 2.3` = 4e-16 рахувався б вільним — склад з підписом «0» обирався б сам.
 */
export function freeOf(row: StockByWarehouseRow): number {
  const free = row.available ?? Number(row.quantity) - Number(row.reserved ?? 0);
  return Number.isFinite(free) ? Math.max(0, Math.round(free * 1000) / 1000) : 0;
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

/**
 * Склад запчастини, яку додала ПОСЛУГА (BR-WO-038, рішення власника 2026-10-31: «де товар є, інакше
 * основний»). На відміну від `pickPartWarehouse` склад підставляється завжди — людина не обирала
 * товар сама, і порожнє поле вона б пропустила:
 *  1. серед складів ФІЛІЇ наряду — той, де вільної кількості найбільше (рівність → основний, далі
 *     порядок переліку: сервер віддає основний першим, решту за назвою);
 *  2. вільної немає на жодному складі філії, або залишки отримати не вдалося (`free = null`) →
 *     основний склад філії (`isMain` — прапорець організації: у філії його може й не бути);
 *  3. основного у філії немає → перший склад філії типу «Основний» (MAIN), інакше перший будь-який.
 * Філію ще не обрано → усі склади переліку; у філії складів немає → '' (обирає людина).
 */
export function pickServicePartWarehouse(
  free: readonly WarehouseFree[] | null,
  warehouses: readonly PickableWarehouse[],
  branchId: string,
): string {
  const own = branchId ? warehouses.filter(w => w.branchId === branchId) : [...warehouses];
  if (own.length === 0) return '';
  const freeOn = new Map((free ?? []).map(f => [f.warehouseId, f.available]));
  let best: PickableWarehouse | undefined;
  let bestFree = 0;
  for (const w of own) {
    const qty = freeOn.get(w.id) ?? 0;
    if (qty > bestFree || (qty > 0 && qty === bestFree && w.isMain && !best?.isMain)) {
      best = w;
      bestFree = qty;
    }
  }
  if (best) return best.id;
  return (own.find(w => w.isMain) ?? own.find(w => w.type === 'MAIN') ?? own[0]).id;
}
