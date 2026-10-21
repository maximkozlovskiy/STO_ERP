import { QTY_EPSILON } from '../../work-orders/work-order-stock-requirements';
import { groupBy } from '../../../common/utils/array';
import { splitOfferKey } from '../adapters/adapter-utils';
import type {
  SupplierCapabilities,
  SupplierConnectionOptions,
} from '../adapters/supplier-adapter.interface';

/**
 * Планування відправки замовлення постачальнику в API (BR-SCON-010) — чиста функція.
 *
 * Рядок замовлення відправляється лише з пропозицією зі знімка позицій списку цього замовлення
 * й товару; ручні рядки (товар без позицій списку) в API не йдуть. Результат — заморожені
 * зовнішні замовлення: по підключенню й, де провайдер замовляє по складу (`orderPerWarehouse`),
 * по складу постачальника; рядок — на пропозицію (`offerKey`) із сумою кількостей.
 */

export interface PlanPurchaseOrder {
  supplierId: string;
  warehouseId: string;
  warehouseName: string;
}

export interface PlanLine {
  goodId: string;
  goodName: string;
  quantity: number;
}

export interface PlanItem {
  goodId: string;
  goodName: string;
  quantity: number;
  offerConnectionId: string | null;
  offerKey: string | null;
  offerSupplierItemId: string | null;
  offerWarehouseCode: string | null;
  offerPrice: number | null;
  offerCurrencyCode: string | null;
}

export interface PlanConnection {
  id: string;
  counterpartyId: string;
  enabled: boolean;
  capabilities: Pick<SupplierCapabilities, 'orderPerWarehouse' | 'requiresWarehouseMapping'>;
  options: SupplierConnectionOptions;
}

export interface PlannedLine {
  goodId: string;
  offerKey: string;
  supplierItemId: string;
  warehouseCode: string | null;
  qtyRequested: number;
  priceRequested: number;
  currencyCode: string;
}

export interface PlannedOrder {
  connectionId: string;
  supplierWarehouseCode: string | null;
  lines: PlannedLine[];
}

export type PlanError =
  | { key: 'err.supplierApi.noApiLines' }
  | { key: 'err.supplierApi.offerFromOtherConnection' }
  | { key: 'err.supplierApi.connectionDisabled' }
  | { key: 'err.supplierApi.lineWithoutOffer'; params: { goods: string } }
  | { key: 'err.supplierApi.ambiguousOffer'; params: { goods: string } }
  | { key: 'err.supplierApi.noWarehouseMapping'; params: { warehouse: string } };

export type PlanResult = { ok: true; orders: PlannedOrder[] } | ({ ok: false } & PlanError);

export function planSupplierOrders(input: {
  po: PlanPurchaseOrder;
  lines: PlanLine[];
  items: PlanItem[];
  connections: Map<string, PlanConnection>;
}): PlanResult {
  const { po, lines, items, connections } = input;
  if (items.length === 0) return { ok: false, key: 'err.supplierApi.noApiLines' };

  const goodsWithoutOffer = new Set<string>();
  for (const i of items) if (!i.offerKey || !i.offerConnectionId) goodsWithoutOffer.add(i.goodName);

  // Пропозиція — лише підключення цього постачальника; вимкнене — не відправляємо.
  for (const i of items) {
    if (!i.offerConnectionId) continue;
    const c = connections.get(i.offerConnectionId);
    if (!c) return { ok: false, key: 'err.supplierApi.connectionDisabled' };
    if (c.counterpartyId !== po.supplierId)
      return { ok: false, key: 'err.supplierApi.offerFromOtherConnection' };
    if (!c.enabled) return { ok: false, key: 'err.supplierApi.connectionDisabled' };
  }
  if (goodsWithoutOffer.size > 0) {
    return {
      ok: false,
      key: 'err.supplierApi.lineWithoutOffer',
      params: { goods: [...goodsWithoutOffer].join(', ') },
    };
  }

  const lineQty = new Map<string, number>();
  for (const l of lines) lineQty.set(l.goodId, (lineQty.get(l.goodId) ?? 0) + l.quantity);

  // Кількість на пропозицію: одна пропозиція на товар — кількість рядка замовлення (його могли
  // змінити в чернетці); кілька — кількості позицій, і вони мусять збігатися з рядком.
  const ambiguous = new Set<string>();
  const qtyByOffer = new Map<string, { item: PlanItem; qty: number }>();
  const byGood = groupBy(items, i => i.goodId);
  for (const [goodId, group] of byGood) {
    const ordered = lineQty.get(goodId) ?? 0;
    if (ordered <= QTY_EPSILON) continue; // товар прибрано з рядків — нічого відправляти
    const keys = new Set(group.map(i => `${i.offerConnectionId}|${i.offerKey}`));
    if (keys.size === 1) {
      qtyByOffer.set(`${goodId}|${[...keys][0]}`, { item: group[0], qty: ordered });
      continue;
    }
    const itemsQty = group.reduce((s, i) => s + i.quantity, 0);
    if (Math.abs(itemsQty - ordered) > QTY_EPSILON) {
      ambiguous.add(group[0].goodName);
      continue;
    }
    for (const i of group) {
      const k = `${goodId}|${i.offerConnectionId}|${i.offerKey}`;
      const prev = qtyByOffer.get(k);
      qtyByOffer.set(k, { item: i, qty: (prev?.qty ?? 0) + i.quantity });
    }
  }
  if (ambiguous.size > 0) {
    return {
      ok: false,
      key: 'err.supplierApi.ambiguousOffer',
      params: { goods: [...ambiguous].join(', ') },
    };
  }
  if (qtyByOffer.size === 0) return { ok: false, key: 'err.supplierApi.noApiLines' };

  const orders = new Map<string, PlannedOrder>();
  for (const { item, qty } of qtyByOffer.values()) {
    const c = connections.get(item.offerConnectionId as string) as PlanConnection;
    if (c.capabilities.requiresWarehouseMapping && !c.options.warehouses?.[po.warehouseId]) {
      return {
        ok: false,
        key: 'err.supplierApi.noWarehouseMapping',
        params: { warehouse: po.warehouseName },
      };
    }
    const whCode = c.capabilities.orderPerWarehouse ? item.offerWarehouseCode : null;
    const orderKey = `${c.id}|${whCode ?? ''}`;
    const order = orders.get(orderKey) ?? {
      connectionId: c.id,
      supplierWarehouseCode: whCode,
      lines: [],
    };
    order.lines.push({
      goodId: item.goodId,
      offerKey: item.offerKey as string,
      supplierItemId: item.offerSupplierItemId ?? splitOfferKey(item.offerKey as string)[0],
      warehouseCode: item.offerWarehouseCode,
      qtyRequested: qty,
      priceRequested: item.offerPrice ?? 0,
      currencyCode: item.offerCurrencyCode ?? 'UAH',
    });
    orders.set(orderKey, order);
  }
  return { ok: true, orders: [...orders.values()] };
}

/** Підсумок на замовленні (BR-SCON-013) за станами його зовнішніх замовлень і рядків. */
export function summarizeSupplierApiStatus(
  orders: Array<{
    status: string;
    lines: Array<{ qtyRequested: number; qtyConfirmed: number | null }>;
  }>,
): 'NOT_SENT' | 'QUEUED' | 'SENT' | 'PARTIAL' | 'CONFIRMED' | 'FAILED' | 'NEEDS_ATTENTION' {
  const live = orders.filter(
    o => o.status !== 'CANCELLED' || o.lines.some(l => l.qtyConfirmed !== null),
  );
  if (live.length === 0) return 'NOT_SENT';
  if (live.some(o => o.status === 'UNKNOWN')) return 'NEEDS_ATTENTION';
  if (live.some(o => o.status === 'FAILED')) return 'FAILED';
  if (live.some(o => o.status === 'QUEUED' || o.status === 'SENDING')) return 'QUEUED';
  const underConfirmed = live.some(
    o =>
      o.status === 'PARTIALLY_CONFIRMED' ||
      o.status === 'REJECTED' ||
      o.status === 'CANCELLED' ||
      o.lines.some(l => l.qtyConfirmed !== null && l.qtyConfirmed < l.qtyRequested - QTY_EPSILON),
  );
  if (underConfirmed) return 'PARTIAL';
  const allConfirmed = live.every(
    o =>
      ['CONFIRMED', 'READY', 'SHIPPED'].includes(o.status) &&
      o.lines.every(l => l.qtyConfirmed !== null && l.qtyConfirmed >= l.qtyRequested - QTY_EPSILON),
  );
  return allConfirmed ? 'CONFIRMED' : 'SENT';
}
