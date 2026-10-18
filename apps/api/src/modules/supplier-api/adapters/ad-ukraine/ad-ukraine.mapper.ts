import type { SupplierOrderStatus } from '@prisma/client';
import { asArray, asRecord, parsePrice, parseQty, str } from '../adapter-utils';
import type { ConfirmedLine, NormalizedOffer } from '../supplier-adapter.interface';

/**
 * AD Ukraine / АвтоТехнікс — нормалізація за https://api.ad.ua/swagger/eCom.OpenApi.v2/swagger.json
 * («Клієнтське АПІ», Swagger 2.0; прочитано 2026-10-18). Поле → джерело:
 *  - `POST /api/v2/ecom/auth/login` {login, pwd, company} → data.token (JWT; заголовок
 *    `Authorization: Bearer <token>` — securityDefinitions.JWT);
 *  - `POST /api/v2/ecom/item/search` {code} → data.rows[] (ItemDataDto): itemNo, itemNo2, brand,
 *    description, inStock, retail, price (ціна клієнта), stock[]{location, quantity — рядок};
 *    до 100 рядків. Валюти відповідь не містить — гривня (звірити наживо);
 *  - `POST /api/v2/ecom/order/create` {items[]{itemNo, quantity}, locationCode, customerComment} →
 *    data.docNo; `order/one` {docNo} і `order/list` {page} — лише НЕвідвантажені замовлення:
 *    status (int), documentStatusName, customerComment, lines[]{itemNo, locationCode, quantity,
 *    reserve, unitPrice}. Словник status у специфікації не наведено — звірити наживо.
 */

export const adOfferKey = (itemNo: string, location: string) => `${itemNo}|${location}`;

export function parseAdOfferKey(key: string): { itemNo: string; location: string } {
  const [itemNo = '', location = ''] = key.split('|');
  return { itemNo, location };
}

export function adRowToOffers(raw: unknown): NormalizedOffer[] {
  const r = asRecord(raw);
  const itemNo = str(r.itemNo);
  if (!itemNo) return [];
  return asArray(r.stock).flatMap(s => {
    const st = asRecord(s);
    const location = str(st.location);
    if (!location) return [];
    const q = parseQty(st.quantity);
    return [
      {
        supplierItemId: itemNo,
        article: itemNo,
        brand: str(r.brand),
        name: str(r.description),
        price: parsePrice(r.price),
        currencyCode: 'UAH',
        qty: q.qty,
        qtyIsLowerBound: q.lowerBound,
        warehouseCode: location,
        warehouseName: location,
        deliveryDays: null,
        deliveryDate: null,
        multiplicity: null,
        isAnalog: false,
        offerKey: adOfferKey(itemNo, location),
      },
    ];
  });
}

/**
 * Замовлення з `order/one`: словника `status` специфікація не наводить, тож нормалізований статус
 * не вгадуємо — `null` (BR-SCON-012: невідомий сирий статус не змінює нормалізованого), сирий
 * зберігаємо як `<status>:<documentStatusName>`; таблицю — після живої звірки. Підтверджена
 * кількість — `quantity` рядків (docs/INTEGRATIONS.md, «AD»).
 */
export function mapAdOrder(data: Record<string, unknown>): {
  status: SupplierOrderStatus | null;
  statusRaw: string;
  lines: ConfirmedLine[];
} {
  const lines = asArray(data.lines).flatMap(l => {
    const line = asRecord(l);
    const itemNo = str(line.itemNo);
    if (!itemNo) return [];
    const price = parsePrice(line.unitPrice);
    return [
      {
        supplierItemId: itemNo,
        warehouseCode: str(line.locationCode),
        qtyConfirmed: Number(line.quantity) || 0,
        priceConfirmed: Number.isFinite(price) ? price : null,
        externalLineId: str(line.lineNo),
      },
    ];
  });
  return {
    status: null,
    statusRaw: `${str(data.status) ?? ''}:${str(data.documentStatusName) ?? ''}`,
    lines,
  };
}
