import { describe, expect, it } from 'vitest';
import {
  planSupplierOrders,
  summarizeSupplierApiStatus,
  type PlanConnection,
  type PlanItem,
} from './supplier-order-planner';

/** Планування відправки (BR-SCON-010) і підсумок на замовленні (BR-SCON-013) — чисті функції. */
const SUP = 'sup-1';
const po = { supplierId: SUP, warehouseId: 'wh-1', warehouseName: 'Основний склад' };
const conn = (over: Partial<PlanConnection> = {}): PlanConnection => ({
  id: 'c-1',
  counterpartyId: SUP,
  enabled: true,
  capabilities: { orderPerWarehouse: false, requiresWarehouseMapping: false },
  options: {},
  ...over,
});
const item = (over: Partial<PlanItem> = {}): PlanItem => ({
  goodId: 'g-1',
  goodName: 'Фільтр',
  quantity: 4,
  offerConnectionId: 'c-1',
  offerKey: 'p1|w1',
  offerSupplierItemId: 'p1',
  offerWarehouseCode: 'w1',
  offerPrice: 120,
  offerCurrencyCode: 'UAH',
  ...over,
});
const plan = (
  items: PlanItem[],
  lines = [{ goodId: 'g-1', goodName: 'Фільтр', quantity: 4 }],
  conns = [conn()],
) => planSupplierOrders({ po, lines, items, connections: new Map(conns.map(c => [c.id, c])) });

describe('BR-SCON-010 планування відправки', () => {
  // guards: BR-SCON-010
  it('рядок — з пропозицією зі знімка позиції; кількість — з рядка замовлення (одна пропозиція)', () => {
    expect(plan([item()], [{ goodId: 'g-1', goodName: 'Фільтр', quantity: 5 }])).toEqual({
      ok: true,
      orders: [
        {
          connectionId: 'c-1',
          supplierWarehouseCode: null,
          lines: [
            {
              goodId: 'g-1',
              offerKey: 'p1|w1',
              supplierItemId: 'p1',
              warehouseCode: 'w1',
              qtyRequested: 5,
              priceRequested: 120,
              currencyCode: 'UAH',
            },
          ],
        },
      ],
    });
  });

  // guards: BR-SCON-010
  it('ручні рядки (товар без позицій списку) в API не йдуть', () => {
    const res = plan(
      [item()],
      [
        { goodId: 'g-1', goodName: 'Фільтр', quantity: 4 },
        { goodId: 'g-manual', goodName: 'Мастило', quantity: 2 },
      ],
    );
    expect(res.ok && res.orders[0].lines.map(l => l.goodId)).toEqual(['g-1']);
    expect(plan([])).toEqual({ ok: false, key: 'err.supplierApi.noApiLines' });
  });

  // guards: BR-SCON-010
  it('позиція без пропозиції → lineWithoutOffer з назвами товарів', () => {
    expect(
      plan([
        item(),
        item({ goodId: 'g-2', goodName: 'Колодки', offerKey: null, offerConnectionId: null }),
      ]),
    ).toEqual({
      ok: false,
      key: 'err.supplierApi.lineWithoutOffer',
      params: { goods: 'Колодки' },
    });
  });

  // guards: BR-SCON-010
  it('різні пропозиції на товар із розбіжною кількістю → ambiguousOffer; збігається — рядок на кожну', () => {
    const two = [
      item({ quantity: 2 }),
      item({ quantity: 2, offerKey: 'p1|w2', offerWarehouseCode: 'w2' }),
    ];
    expect(plan(two, [{ goodId: 'g-1', goodName: 'Фільтр', quantity: 5 }])).toEqual({
      ok: false,
      key: 'err.supplierApi.ambiguousOffer',
      params: { goods: 'Фільтр' },
    });
    const ok = plan(two, [{ goodId: 'g-1', goodName: 'Фільтр', quantity: 4 }]);
    expect(ok.ok && ok.orders[0].lines.map(l => [l.offerKey, l.qtyRequested])).toEqual([
      ['p1|w1', 2],
      ['p1|w2', 2],
    ]);
  });

  // guards: BR-SCON-010
  it('пропозиція іншого постачальника → offerFromOtherConnection; вимкнене підключення → connectionDisabled', () => {
    expect(plan([item()], undefined, [conn({ counterpartyId: 'sup-other' })])).toEqual({
      ok: false,
      key: 'err.supplierApi.offerFromOtherConnection',
    });
    expect(plan([item()], undefined, [conn({ enabled: false })])).toEqual({
      ok: false,
      key: 'err.supplierApi.connectionDisabled',
    });
    expect(plan([item()], undefined, [])).toEqual({
      ok: false,
      key: 'err.supplierApi.connectionDisabled',
    });
  });

  // guards: BR-SCON-010
  it('провайдер вимагає параметрів доставки для нашого складу, а їх немає → noWarehouseMapping', () => {
    const needs = conn({
      capabilities: { orderPerWarehouse: false, requiresWarehouseMapping: true },
    });
    expect(plan([item()], undefined, [needs])).toEqual({
      ok: false,
      key: 'err.supplierApi.noWarehouseMapping',
      params: { warehouse: 'Основний склад' },
    });
    const mapped = conn({
      capabilities: needs.capabilities,
      options: { warehouses: { 'wh-1': { locationUuid: 'l' } } },
    });
    expect(plan([item()], undefined, [mapped]).ok).toBe(true);
  });

  // guards: BR-SCON-010
  it('замовлення по складу постачальника (orderPerWarehouse) — окреме зовнішнє на кожен склад', () => {
    const perWh = conn({
      capabilities: { orderPerWarehouse: true, requiresWarehouseMapping: false },
    });
    const res = plan(
      [item({ quantity: 1 }), item({ quantity: 3, offerKey: 'p1|w2', offerWarehouseCode: 'w2' })],
      [{ goodId: 'g-1', goodName: 'Фільтр', quantity: 4 }],
      [perWh],
    );
    expect(res.ok && res.orders.map(o => [o.supplierWarehouseCode, o.lines.length])).toEqual([
      ['w1', 1],
      ['w2', 1],
    ]);
  });
});

describe('BR-SCON-013 підсумок supplierApiStatus', () => {
  const line = (req: number, conf: number | null) => ({ qtyRequested: req, qtyConfirmed: conf });
  // guards: BR-SCON-013
  it.each([
    [[], 'NOT_SENT'],
    [[{ status: 'QUEUED', lines: [line(2, null)] }], 'QUEUED'],
    [[{ status: 'PLACED', lines: [line(2, null)] }], 'SENT'],
    [
      [
        { status: 'CONFIRMED', lines: [line(2, 2)] },
        { status: 'SHIPPED', lines: [line(1, 1)] },
      ],
      'CONFIRMED',
    ],
    [[{ status: 'CONFIRMED', lines: [line(2, 1)] }], 'PARTIAL'],
    [
      [
        { status: 'PARTIALLY_CONFIRMED', lines: [line(2, 1)] },
        { status: 'CONFIRMED', lines: [line(1, 1)] },
      ],
      'PARTIAL',
    ],
    [[{ status: 'REJECTED', lines: [line(2, 0)] }], 'PARTIAL'],
    [
      [
        { status: 'FAILED', lines: [line(2, null)] },
        { status: 'CONFIRMED', lines: [line(1, 1)] },
      ],
      'FAILED',
    ],
    [
      [
        { status: 'UNKNOWN', lines: [line(2, null)] },
        { status: 'FAILED', lines: [line(1, null)] },
      ],
      'NEEDS_ATTENTION',
    ],
    [[{ status: 'CANCELLED', lines: [line(2, null)] }], 'NOT_SENT'],
  ])('%j → %s', (orders, expected) => {
    expect(summarizeSupplierApiStatus(orders)).toBe(expected);
  });
});
