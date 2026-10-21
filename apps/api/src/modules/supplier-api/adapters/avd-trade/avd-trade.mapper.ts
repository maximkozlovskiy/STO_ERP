import type { SupplierOrderStatus } from '@prisma/client';
import {
  asArray,
  asRecord,
  joinOfferKey,
  parsePrice,
  parseQty,
  splitOfferKey,
  str,
} from '../adapter-utils';
import type {
  CatalogMirrorRow,
  ConfirmedLine,
  NormalizedOffer,
} from '../supplier-adapter.interface';

/**
 * AVD Trade — нормалізація за офіційною специфікацією
 * https://dev-api.avdtrade.com.ua/openapi.yaml (AVDtrade public API 1.2.0, прочитано 2026-10-18).
 * Поле → джерело:
 *  - товар `POST /items/query` → data.items[]: uuid, article, brand, name, price{currency, value,
 *    type}, stock[]{warehouse_uuid, warehouse, is_capped, quantity} («quantity — максимальне
 *    значення 10, is_capped: залишок більше 10»);
 *  - замовлення `GET /orders` → data.orders[]: uuid (успадковано від кошика), status, number,
 *    lines[]{item{uuid}, warehouse_uuid, quantity, price};
 *  - оформлення `POST /carts/{uuid}/checkout` → data.processing{flow, status},
 *    data.lines_result[]{item_uuid, warehouse_uuid, requested_quantity, confirmed_quantity, status}.
 * Терміну постачання AVD не віддає — його бере стратегія з підключення (BR-SOFR-007).
 */

/** Ключ пропозиції AVD: товар + склад (рядок кошика — `item_uuid` + `warehouse_uuid`). */
export const avdOfferKey = joinOfferKey;

export function parseAvdOfferKey(key: string): { itemUuid: string; warehouseUuid: string } {
  const [itemUuid, warehouseUuid] = splitOfferKey(key);
  return { itemUuid, warehouseUuid };
}

/** Позиція `items/query` → рядок дзеркала; без uuid чи артикула — null. */
export function avdItemToMirror(raw: unknown): CatalogMirrorRow | null {
  const item = asRecord(raw);
  const uuid = str(item.uuid);
  const article = str(item.article);
  if (!uuid || !article) return null;
  const price = asRecord(item.price);
  return {
    supplierItemId: uuid,
    article,
    brand: str(item.brand),
    name: str(item.name),
    price: parsePrice(price.value),
    currencyCode: str(price.currency) ?? 'UAH',
    priceType: str(price.type),
    stock: asArray(item.stock).flatMap(s => {
      const r = asRecord(s);
      const code = str(r.warehouse_uuid);
      if (!code) return [];
      const qty = Number(r.quantity);
      return [
        {
          warehouseCode: code,
          warehouseName: str(r.warehouse),
          qty: Number.isFinite(qty) ? qty : 0,
          isCapped: r.is_capped === true,
        },
      ];
    }),
  };
}

/**
 * Рядок дзеркала → пропозиції по складах із залишком. «≥10» (is_capped) — рівно 10 як нижня межа
 * (рішення за замовчуванням у плані).
 */
export function mirrorRowToOffers(row: {
  supplierItemId: string;
  article: string;
  brand: string | null;
  name: string | null;
  price: number;
  currencyCode: string;
  stock: unknown;
}): NormalizedOffer[] {
  return asArray(row.stock).flatMap(raw => {
    const s = asRecord(raw);
    const code = str(s.warehouseCode);
    const qty = Number(s.qty);
    if (!code || !Number.isFinite(qty) || qty <= 0) return [];
    return [
      {
        supplierItemId: row.supplierItemId,
        article: row.article,
        brand: row.brand,
        name: row.name,
        price: row.price,
        currencyCode: row.currencyCode,
        qty,
        qtyIsLowerBound: s.isCapped === true,
        warehouseCode: code,
        warehouseName: str(s.warehouseName),
        deliveryDays: null,
        deliveryDate: null,
        multiplicity: null,
        isAnalog: false,
        offerKey: avdOfferKey(row.supplierItemId, code),
      },
    ];
  });
}

/** Статуси AVD (документація, розділи «Кошик» і «Замовлення»). Невідомий — null (BR-SCON-012). */
export const AVD_STATUS_MAP: Readonly<Record<string, SupplierOrderStatus>> = {
  // Кошик після оформлення, якщо перевищено кредитний ліміт: розглядає менеджер.
  'Запит на відвантаження': 'PLACED',
  'В обробці': 'PLACED',
  // Замовлення — послідовно.
  'В черзі на відправку': 'CONFIRMED',
  Консолідація: 'CONFIRMED',
  'Відправлено на зборку': 'CONFIRMED',
  'Готовий до відвантаження': 'READY',
  'Відправлено (відвантажено)': 'SHIPPED',
};

export function mapAvdStatus(raw: string | null | undefined): SupplierOrderStatus | null {
  return raw ? (AVD_STATUS_MAP[raw.trim()] ?? null) : null;
}

/** Рядки замовлення `GET /orders` → підтверджені кількості по (товар, склад). */
export function avdOrderLines(order: Record<string, unknown>): ConfirmedLine[] {
  return asArray(order.lines).flatMap(raw => {
    const l = asRecord(raw);
    const itemUuid = str(asRecord(l.item).uuid);
    if (!itemUuid) return [];
    return [
      {
        supplierItemId: itemUuid,
        warehouseCode: str(l.warehouse_uuid),
        qtyConfirmed: Number(l.quantity) || 0,
        priceConfirmed: Number.isFinite(parsePrice(l.price)) ? parsePrice(l.price) : null,
        statusRaw: null,
      },
    ];
  });
}

/** `lines_result` оформлення → підтверджені кількості. */
export function avdCheckoutLines(data: Record<string, unknown>): ConfirmedLine[] {
  return asArray(data.lines_result).flatMap(raw => {
    const l = asRecord(raw);
    const itemUuid = str(l.item_uuid);
    if (!itemUuid) return [];
    return [
      {
        supplierItemId: itemUuid,
        warehouseCode: str(l.warehouse_uuid),
        qtyConfirmed: Number(l.confirmed_quantity) || 0,
        statusRaw: str(l.status),
        externalLineId: str(l.line_uuid),
      },
    ];
  });
}

/**
 * CSV прайсу `GET /price/export`. Формат колонок специфікація НЕ описує (лише приклад посилання
 * на .csv) — розбір за заголовками, з розділювачем «;» або «,»; звірити наживо (docs/INTEGRATIONS.md).
 * Колонки складів — усі числові колонки, що не впізнані як службові.
 */
export function parseAvdPriceCsv(text: string): CatalogMirrorRow[] {
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter(l => l.trim() !== '');
  if (lines.length < 2) return [];
  const delimiter =
    (lines[0].match(/;/g)?.length ?? 0) >= (lines[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  const split = (l: string) => splitCsvLine(l, delimiter);
  const rawHeader = split(lines[0]).map(h => h.trim());
  const header = rawHeader.map(h => h.toLowerCase());
  const find = (re: RegExp) => header.findIndex(h => re.test(h));
  const col = {
    uuid: find(/^(item_)?uuid$|ідентифікатор|^id$/),
    article: find(/article|артикул/),
    brand: find(/brand|бренд/),
    name: find(/name|назва|найменування/),
    price: find(/price|ціна/),
    currency: find(/currency|валюта/),
  };
  if (col.uuid < 0 || col.article < 0 || col.price < 0) return [];
  const known = new Set(Object.values(col).filter(i => i >= 0));
  const stockCols = rawHeader.map((h, i) => ({ h, i })).filter(c => !known.has(c.i));
  const rows: CatalogMirrorRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = split(line);
    const uuid = cells[col.uuid]?.trim();
    const article = cells[col.article]?.trim();
    if (!uuid || !article) continue;
    rows.push({
      supplierItemId: uuid,
      article,
      brand: col.brand >= 0 ? cells[col.brand]?.trim() || null : null,
      name: col.name >= 0 ? cells[col.name]?.trim() || null : null,
      price: parsePrice(cells[col.price]),
      currencyCode: col.currency >= 0 ? cells[col.currency]?.trim() || 'UAH' : 'UAH',
      priceType: null,
      stock: stockCols.flatMap(c => {
        const { qty, lowerBound } = parseQty(cells[c.i] ?? '');
        if (!Number.isFinite(qty) || qty <= 0) return [];
        return [{ warehouseCode: c.h, warehouseName: c.h, qty, isCapped: lowerBound }];
      }),
    });
  }
  return rows;
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
