import type { SupplierOrderStatus } from '@prisma/client';
import { kyivOffsetMs } from '../../../../common/utils/kyiv-date';
import { asArray, asRecord, parsePrice, parseQty, positiveIntOrNull, str } from '../adapter-utils';
import type { ConfirmedLine, NormalizedOffer } from '../supplier-adapter.interface';

/**
 * UTR (UniqTrade API v2) — нормалізація за вікі https://api.utr.ua (сторінки «Аутентифікація і
 * авторизація», «Пошук деталі по артикулу і бренду», «Оформлення замовлення», «Перегляд
 * замовлення», «Перегляд списку замовлень», «Отримання варіантів доставки»; прочитано 2026-10-18).
 * Поле → джерело:
 *  - пошук `GET /api/search/{oem}?brand=` → details[]: id (код товару для замовлення), brand.name,
 *    displayBrand, article, title, multiplicity, yourPrice{amount, currency.code},
 *    remains[]{storage{id, name}, remain: «4» | «> 10»};
 *  - замовлення `POST /api/order/accept` (201) і `GET /api/order/{id}` → id, externalCode, status,
 *    comment, orderItems[]{detail.id, storage.id, quantity, price.amount}.
 * Аналоги: `GET /api/analogs/{brand}/{oem}` виведено з експлуатації 07.10.2026 (410 Gone) —
 * аналогів UTR не дає. Терміну постачання пошук не віддає.
 */

export const utrOfferKey = (detailId: string, storageId: string) => `${detailId}|${storageId}`;

export function parseUtrOfferKey(key: string): { detailId: number; storageId: number } {
  const [d = '', s = ''] = key.split('|');
  return { detailId: Number(d), storageId: Number(s) };
}

export function utrDetailToOffers(raw: unknown): NormalizedOffer[] {
  const d = asRecord(raw);
  const id = str(d.id);
  const article = str(d.article);
  if (!id || !article) return [];
  const price = asRecord(d.yourPrice);
  const currency = str(asRecord(price.currency).code) ?? 'UAH';
  const brand = str(d.displayBrand) ?? str(asRecord(d.brand).name);
  return asArray(d.remains).flatMap(r => {
    const rem = asRecord(r);
    const storage = asRecord(rem.storage);
    const storageId = str(storage.id);
    if (!storageId) return [];
    const q = parseQty(rem.remain);
    return [
      {
        supplierItemId: id,
        article,
        brand,
        name: str(d.title),
        price: parsePrice(price.amount),
        currencyCode: currency,
        qty: q.qty,
        qtyIsLowerBound: q.lowerBound,
        warehouseCode: storageId,
        warehouseName: str(storage.name),
        deliveryDays: null,
        deliveryDate: null,
        multiplicity: positiveIntOrNull(d.multiplicity),
        isAnalog: false,
        offerKey: utrOfferKey(id, storageId),
      },
    ];
  });
}

/**
 * Статуси замовлення UTR. Документація показує лише `processing` — решту звірити наживо
 * (docs/INTEGRATIONS.md); невідомий сирий статус нормалізований не змінює (BR-SCON-012).
 */
export const UTR_STATUS_MAP: Readonly<Record<string, SupplierOrderStatus>> = {
  processing: 'CONFIRMED',
};

export function mapUtrStatus(raw: string | null | undefined): SupplierOrderStatus | null {
  return raw ? (UTR_STATUS_MAP[raw.trim().toLowerCase()] ?? null) : null;
}

export function utrOrderLines(order: Record<string, unknown>): ConfirmedLine[] {
  return asArray(order.orderItems).flatMap(raw => {
    const it = asRecord(raw);
    const detailId = str(asRecord(it.detail).id);
    if (!detailId) return [];
    const price = parsePrice(asRecord(it.price).amount);
    return [
      {
        supplierItemId: detailId,
        warehouseCode: str(asRecord(it.storage).id),
        qtyConfirmed: Number(it.quantity) || 0,
        priceConfirmed: Number.isFinite(price) ? price : null,
      },
    ];
  });
}

/** «2020-01-17 15:04:50» (час сервера UTR, Київ) → ISO UTC. */
export function utrExpiresAt(raw: unknown): string | null {
  const s = str(raw);
  if (!s || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return null;
  const wall = new Date(`${s.replace(' ', 'T')}Z`);
  if (Number.isNaN(wall.getTime())) return null;
  return new Date(wall.getTime() - kyivOffsetMs(wall)).toISOString();
}
