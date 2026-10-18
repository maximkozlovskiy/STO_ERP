import type { SupplierOrderStatus } from '@prisma/client';
import type { ConfirmedLine } from '../adapters/supplier-adapter.interface';

const EPS = 1e-6;

export interface OrderLineRow {
  id: string;
  supplierItemId: string;
  warehouseCode: string | null;
  qtyRequested: number;
  qtyConfirmed: number | null;
}

export interface LineUpdate {
  id: string;
  qtyConfirmed: number;
  priceConfirmed: number | null;
  statusRaw: string | null;
  externalLineId: string | null;
}

/**
 * Підтвердження постачальника → рядки нашого зовнішнього замовлення: за товаром постачальника
 * і, якщо постачальник його назвав, складом. Кілька рядків відповіді на один наш — сума.
 */
export function matchConfirmedLines(
  rows: OrderLineRow[],
  confirmed: ConfirmedLine[] | undefined,
): LineUpdate[] {
  if (!confirmed || confirmed.length === 0) return [];
  const byRow = new Map<string, LineUpdate>();
  for (const c of confirmed) {
    const row =
      rows.find(
        r =>
          r.supplierItemId === c.supplierItemId &&
          c.warehouseCode &&
          r.warehouseCode === c.warehouseCode,
      ) ?? rows.find(r => r.supplierItemId === c.supplierItemId);
    if (!row) continue;
    const prev = byRow.get(row.id);
    byRow.set(row.id, {
      id: row.id,
      qtyConfirmed: (prev?.qtyConfirmed ?? 0) + c.qtyConfirmed,
      priceConfirmed: c.priceConfirmed ?? prev?.priceConfirmed ?? null,
      statusRaw: c.statusRaw ?? prev?.statusRaw ?? null,
      externalLineId: c.externalLineId ?? prev?.externalLineId ?? null,
    });
  }
  return [...byRow.values()];
}

/**
 * «Підтверджено», але не все: якщо після оновлення хоч один рядок підтверджено менше, ніж
 * запитано, — PARTIALLY_CONFIRMED (BR-SCON-013).
 */
export function adjustForPartial(
  status: SupplierOrderStatus,
  rows: OrderLineRow[],
  updates: LineUpdate[],
): SupplierOrderStatus {
  if (status !== 'CONFIRMED') return status;
  const confirmedOf = (r: OrderLineRow) =>
    updates.find(u => u.id === r.id)?.qtyConfirmed ?? r.qtyConfirmed;
  const under = rows.some(r => {
    const q = confirmedOf(r);
    return q !== null && q < r.qtyRequested - EPS;
  });
  return under ? 'PARTIALLY_CONFIRMED' : status;
}

/** Зовнішні статуси, на яких опитування зупиняється. */
export const TERMINAL_SUPPLIER_ORDER_STATUSES: readonly SupplierOrderStatus[] = [
  'SHIPPED',
  'REJECTED',
  'CANCELLED',
];

/** Що опитувати: відправлене й не завершене; UNKNOWN — звірка за reference ще може знайти. */
export const POLLABLE_SUPPLIER_ORDER_STATUSES: readonly SupplierOrderStatus[] = [
  'PLACED',
  'CONFIRMED',
  'PARTIALLY_CONFIRMED',
  'READY',
  'UNKNOWN',
];
