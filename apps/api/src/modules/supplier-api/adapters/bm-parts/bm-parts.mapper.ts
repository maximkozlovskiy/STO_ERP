import type { SupplierOrderStatus } from '@prisma/client';
import { asArray, asRecord, parsePrice, parseQty, positiveIntOrNull, str } from '../adapter-utils';
import type { ConfirmedLine, NormalizedOffer } from '../supplier-adapter.interface';

/**
 * BM Parts — нормалізація за https://developer.bm.parts/openapi.json (REST API, прочитано
 * 2026-10-18) і сторінкою https://developer.bm.parts/tutorials/test-mode.
 * Поле → джерело:
 *  - `GET /search/products?q=&search_mode=strict&products_as=arr&warehouses=all` →
 *    products[] (SearchProductItemSchema): uuid, article, brand, name, price («325.50», рядок),
 *    currency_name, multiplicity, in_stocks[]{uuid, name, short_name, quantity — рядок,
 *    «може бути '>' або '-'»};
 *  - `GET /product/{uuid}?analogs_available=1` → product.analogs — схема в специфікації
 *    порожня («Аналоги», object, nullable): розбираємо і мапу uuid → картка, і масив карток;
 *    звірити наживо (docs/INTEGRATIONS.md);
 *  - `POST /shopping/reserve/process` → {uuid, result, analysis[]{uuid, planned, reserved}, error};
 *  - `GET /shopping/reserves` → reserves[] / picking[]{warehouse_uuid, orders[]{uuid, number,
 *    status, comment}}.
 * Терміну постачання пошук не віддає.
 */

export const bmOfferKey = (productUuid: string, warehouseUuid: string) =>
  `${productUuid}|${warehouseUuid}`;

export function parseBmOfferKey(key: string): { productUuid: string; warehouseUuid: string } {
  const [productUuid = '', warehouseUuid = ''] = key.split('|');
  return { productUuid, warehouseUuid };
}

/** Картка товару → пропозиції по складах `in_stocks` (без «На інших» і «Очікується»). */
export function bmCardToOffers(
  raw: unknown,
  uuidHint: string | null,
  isAnalog: boolean,
): NormalizedOffer[] {
  const card = asRecord(raw);
  const uuid = str(card.uuid) ?? uuidHint;
  const article = str(card.article);
  if (!uuid || !article) return [];
  const price = parsePrice(card.price);
  return asArray(card.in_stocks).flatMap(s => {
    const st = asRecord(s);
    const wh = str(st.uuid);
    if (!wh || wh === '-') return [];
    const q = parseQty(st.quantity);
    return [
      {
        supplierItemId: uuid,
        article,
        brand: str(card.brand),
        name: str(card.name),
        price,
        currencyCode: str(card.currency_name) ?? 'UAH',
        qty: q.qty,
        qtyIsLowerBound: q.lowerBound,
        warehouseCode: wh,
        warehouseName: str(st.short_name) ?? str(st.name),
        deliveryDays: null,
        deliveryDate: null,
        multiplicity: positiveIntOrNull(card.multiplicity),
        isAnalog,
        offerKey: bmOfferKey(uuid, wh),
      },
    ];
  });
}

/** `products` пошуку чи `analogs` картки: масив карток або мапа uuid → картка. */
export function bmCards(raw: unknown): Array<{ uuid: string | null; card: unknown }> {
  if (Array.isArray(raw)) return raw.map(card => ({ uuid: str(asRecord(card).uuid), card }));
  return Object.entries(asRecord(raw)).map(([uuid, card]) => ({ uuid, card }));
}

export function bmReserveLines(data: Record<string, unknown>): ConfirmedLine[] {
  return asArray(data.analysis).flatMap(a => {
    const r = asRecord(a);
    const uuid = str(r.uuid);
    if (!uuid) return [];
    return [{ supplierItemId: uuid, qtyConfirmed: Number(r.reserved) || 0 }];
  });
}

/**
 * Гілки `GET /shopping/reserves`: «reserves» — резерв прийнято (товар закріплено за нами),
 * «picking» — замовлення в обробці складом. Окремого словника статусів специфікація не дає —
 * звірити наживо; сирий статус зберігається як `<гілка>:<status>`.
 */
export const BM_BRANCH_STATUS: Readonly<Record<string, SupplierOrderStatus>> = {
  reserves: 'CONFIRMED',
  picking: 'READY',
};

export interface BmReserveHit {
  branch: string;
  order: Record<string, unknown>;
}

export function findBmReserve(
  data: Record<string, unknown>,
  match: (order: Record<string, unknown>) => boolean,
): BmReserveHit | null {
  for (const branch of ['picking', 'reserves']) {
    for (const group of asArray(data[branch])) {
      for (const o of asArray(asRecord(group).orders)) {
        const order = asRecord(o);
        if (match(order)) return { branch, order };
      }
    }
  }
  return null;
}
