import type { SupplierOrderStatus } from '@prisma/client';
import {
  asArray,
  asRecord,
  parsePrice,
  parseSupplierDate,
  positiveIntOrNull,
  str,
} from '../adapter-utils';
import type { ConfirmedLine, NormalizedOffer } from '../supplier-adapter.interface';

/**
 * Tehnomir — нормалізація за swagger https://tehnomir.com.ua/index.php?r=swagger%2Fjson-schema
 * (OpenAPI 3.0, сервер https://api.tehnomir.com.ua; прочитано 2026-10-18). Усі запити — POST JSON,
 * `apiToken` у тілі. Поле → джерело:
 *  - `/price/search` {code, isShowAnalogs} → data[]{productId, brand, code, descriptionUa/Rus,
 *    rests[]{priceLogo (4-значний код прайсу), price, currency, quantity, quantityType EQUAL|MORE,
 *    multiplicity, deliveryTime (днів), deliveryDate}};
 *  - `/order/getOrderPositions` → data[]{orderPositionId, priceLogo, reference, price, currency,
 *    states[]{quantity, statusId, status}}. Словник статусів — `/info/getPositionStatuses`, але
 *    назви в специфікації не перелічено: класифікація за назвою стану (таблиця нижче) — звірити
 *    наживо (docs/INTEGRATIONS.md).
 */

export const tehnomirOfferKey = (productId: string, priceLogo: string) =>
  `${productId}|${priceLogo}`;

export function parseTehnomirOfferKey(key: string): { productId: number; priceLogo: string } {
  const [p = '', logo = ''] = key.split('|');
  return { productId: Number(p), priceLogo: logo };
}

export function tehnomirProductToOffers(raw: unknown): NormalizedOffer[] {
  const p = asRecord(raw);
  const productId = str(p.productId);
  const code = str(p.code);
  if (!productId || !code) return [];
  return asArray(p.rests).flatMap(r => {
    const rest = asRecord(r);
    const logo = str(rest.priceLogo);
    if (!logo) return [];
    const qty = Number(rest.quantity);
    return [
      {
        supplierItemId: productId,
        article: code,
        brand: str(p.brand),
        name: str(p.descriptionUa) ?? str(p.descriptionRus),
        price: parsePrice(rest.price),
        currencyCode: str(rest.currency) ?? 'UAH',
        qty: Number.isFinite(qty) ? qty : 0,
        qtyIsLowerBound: str(rest.quantityType) === 'MORE',
        warehouseCode: logo,
        warehouseName: str(rest.country) ? `${logo} (${str(rest.country)})` : logo,
        deliveryDays:
          positiveIntOrNull(rest.deliveryTime) ?? (Number(rest.deliveryTime) === 0 ? 0 : null),
        deliveryDate: parseSupplierDate(rest.deliveryDate),
        multiplicity: positiveIntOrNull(rest.multiplicity),
        isAnalog: false,
        offerKey: tehnomirOfferKey(productId, logo),
      },
    ];
  });
}

/** Класифікація стану позиції за назвою (рос./укр.). Невідома назва — «в роботі». */
const STATE_RULES: Array<[RegExp, 'rejected' | 'shipped' | 'ready']> = [
  [/отказ|відмов|снят|знят|аннул|анул|cancel|нет в наличии|немає в наявності/i, 'rejected'],
  [/выдан|видан|отгруж|відвантаж|отправлен|відправлен/i, 'shipped'],
  [/на складе|на склад|готов|прибыл|прибув/i, 'ready'],
];

export function classifyTehnomirState(
  name: string | null,
): 'rejected' | 'shipped' | 'ready' | 'work' {
  if (!name) return 'work';
  for (const [re, kind] of STATE_RULES) if (re.test(name)) return kind;
  return 'work';
}

export interface TehnomirPositionsSummary {
  status: SupplierOrderStatus | null;
  statusRaw: string;
  lines: ConfirmedLine[];
}

/**
 * Позиції замовлення → підсумок. Позиції зіставляються з нашими рядками за `reference`
 * («<reference замовлення>-<№ рядка>»). Кількість без відмови — підтверджена.
 */
export function summarizeTehnomirPositions(
  positions: unknown[],
  lineByReference: Map<string, { supplierItemId: string; warehouseCode: string | null }>,
): TehnomirPositionsSummary {
  let total = 0;
  let rejected = 0;
  let shipped = 0;
  let ready = 0;
  const raw = new Set<string>();
  const lines: ConfirmedLine[] = [];
  for (const p of positions.map(asRecord)) {
    let posTotal = 0;
    let posRejected = 0;
    for (const s of asArray(p.states).map(asRecord)) {
      const q = Number(s.quantity) || 0;
      const name = str(s.status);
      if (name) raw.add(name);
      const kind = classifyTehnomirState(name);
      posTotal += q;
      if (kind === 'rejected') posRejected += q;
      if (kind === 'shipped') shipped += q;
      if (kind === 'ready') ready += q;
    }
    total += posTotal;
    rejected += posRejected;
    const ref = str(p.reference);
    const line = ref ? lineByReference.get(ref) : undefined;
    if (line) {
      const price = parsePrice(p.price);
      lines.push({
        supplierItemId: line.supplierItemId,
        warehouseCode: line.warehouseCode,
        qtyConfirmed: Math.max(0, posTotal - posRejected),
        priceConfirmed: Number.isFinite(price) ? price : null,
        statusRaw:
          asArray(p.states)
            .map(s => str(asRecord(s).status))
            .filter(Boolean)
            .join(', ') || null,
        externalLineId: str(p.orderPositionId),
      });
    }
  }
  const statusRaw = [...raw].join(', ');
  if (total === 0) return { status: null, statusRaw, lines };
  const alive = total - rejected;
  let status: SupplierOrderStatus;
  if (alive === 0) status = 'REJECTED';
  else if (shipped >= alive) status = 'SHIPPED';
  else if (shipped + ready >= alive) status = 'READY';
  else status = 'CONFIRMED';
  return { status, statusRaw, lines };
}
