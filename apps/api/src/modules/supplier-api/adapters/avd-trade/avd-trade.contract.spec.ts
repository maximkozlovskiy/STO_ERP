import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startSupplierFakes, type SupplierFakes } from '../../../../../../../tools/supplier-fakes';
import { connectionCtx, fakeRedis, httpClient, OUR_WH } from '../../supplier-api.spec-fixture';
import { SupplierAuthError, SupplierRateLimitError } from '../../http/supplier-errors';
import {
  createPlaceOrderRunner,
  RECONCILE_STEP,
  SupplierReconcileRequired,
} from '../../orders/place-order-runner';
import type {
  CatalogMirrorRow,
  SupplierOrderInput,
  SupplierOrderState,
} from '../supplier-adapter.interface';
import { AvdTradeAdapter } from './avd-trade.adapter';
import { avdOfferKey, mapAvdStatus, mirrorRowToOffers, parseAvdPriceCsv } from './avd-trade.mapper';

/**
 * Контракт адаптера AVD Trade проти фейкового сервера (tools/supplier-fakes/providers/avd.js —
 * формати з https://dev-api.avdtrade.com.ua/openapi.yaml) зі справжнім fetch.
 */
const WH_ZHYTOMYR = 'a1111111-0000-4000-8000-000000000001';
const WH_KYIV = 'a1111111-0000-4000-8000-000000000002';
const ITEM_OC90 = 'a0000000-0000-4000-8000-000000000001';
const ITEM_W712 = 'a0000000-0000-4000-8000-000000000002';

describe('AvdTradeAdapter — контракт проти фейкового AVD', () => {
  let fakes: SupplierFakes;
  let redis: ReturnType<typeof fakeRedis>;
  let adapter: AvdTradeAdapter;

  const conn = (over: Parameters<typeof connectionCtx>[1] = {}) =>
    connectionCtx('AVD_TRADE', {
      apiUrl: `${fakes.url}/avd/api/v1`,
      credentials: { apiKey: 'avd-test-key' },
      options: {
        warehouses: {
          [OUR_WH]: { locationUuid: 'loc-1', forwarderUuid: 'fwd-1', recipientUuid: 'rcp-1' },
        },
      },
      ...over,
    });

  const orderInput = (over: Partial<SupplierOrderInput> = {}): SupplierOrderInput => ({
    id: 'so-1',
    reference: 'STO-ЗП-2026-000001-1',
    purchaseOrderNumber: 'ЗП-2026-000001',
    supplierWarehouseCode: null,
    ourWarehouseId: OUR_WH,
    sentAt: null,
    lines: [
      {
        lineId: 'l1',
        supplierItemId: ITEM_OC90,
        offerKey: avdOfferKey(ITEM_OC90, WH_ZHYTOMYR),
        warehouseCode: WH_ZHYTOMYR,
        qty: 4,
        price: 127.89,
        currencyCode: 'UAH',
      },
      {
        lineId: 'l2',
        supplierItemId: ITEM_W712,
        offerKey: avdOfferKey(ITEM_W712, WH_ZHYTOMYR),
        warehouseCode: WH_ZHYTOMYR,
        qty: 2,
        price: 115.5,
        currencyCode: 'UAH',
      },
    ],
    ...over,
  });

  const emptyState = (): SupplierOrderState => ({
    step: null,
    externalCartId: null,
    externalOrderId: null,
    externalNumber: null,
  });

  /** Справжній виконавець кроків; «БД» — масив записаних станів. */
  const runner = (initial = emptyState()) => {
    const persisted: Array<Partial<SupplierOrderState>> = [];
    const run = createPlaceOrderRunner(adapter.orderSteps, initial, p => {
      persisted.push(p);
      return Promise.resolve();
    });
    return { run, persisted };
  };

  beforeAll(async () => {
    fakes = await startSupplierFakes();
  });
  afterAll(() => fakes.close());
  beforeEach(() => {
    fakes.reset();
    redis = fakeRedis();
    adapter = new AvdTradeAdapter(httpClient([fakes.url], redis).client);
    adapter.exportPollMs = 0;
  });

  // guards: BR-SCON-008
  it('verify: ключ у заголовку x-api-key; невірний ключ → помилка авторизації', async () => {
    await expect(adapter.verify(conn())).resolves.toBeUndefined();
    expect(fakes.requests('avd')[0].headers['x-api-key']).toBe('avd-test-key');
    await expect(adapter.verify(conn({ credentials: { apiKey: 'wrong' } }))).rejects.toBeInstanceOf(
      SupplierAuthError,
    );
  });

  // guards: BR-SCON-015
  it('дзеркало: items/query посторінково з has_stock; «≥10» (is_capped) — 10 як нижня межа', async () => {
    const rows: CatalogMirrorRow[] = [];
    const res = await adapter.syncCatalog(conn(), {
      upsert: r => Promise.resolve(void rows.push(...r)),
    });
    expect(res.count).toBe(3); // K015578XS без залишку відкинуто has_stock
    const q = fakes.requests('avd').find(r => r.path === '/api/v1/items/query');
    expect(q?.body).toEqual({ page: 1, per_page: 5000, has_stock: true });
    const oc90 = rows.find(r => r.supplierItemId === ITEM_OC90)!;
    expect(oc90).toMatchObject({
      article: 'OC 90',
      brand: 'MAHLE',
      price: 127.89,
      currencyCode: 'UAH',
    });
    const offers = mirrorRowToOffers(oc90);
    expect(offers).toEqual([
      expect.objectContaining({
        warehouseCode: WH_ZHYTOMYR,
        qty: 4,
        qtyIsLowerBound: false,
        offerKey: `${ITEM_OC90}|${WH_ZHYTOMYR}`,
      }),
      expect.objectContaining({
        warehouseCode: WH_KYIV,
        qty: 10,
        qtyIsLowerBound: true,
        offerKey: `${ITEM_OC90}|${WH_KYIV}`,
      }),
    ]);
  });

  // guards: BR-SCON-015
  it('дзеркало: items/query недоступний → price/export, двічі 202, далі CSV; назви складів → uuid', async () => {
    fakes.state.data.avd.queryDisabled = true;
    const rows: CatalogMirrorRow[] = [];
    const res = await adapter.syncCatalog(conn(), {
      upsert: r => Promise.resolve(void rows.push(...r)),
    });
    expect(res.count).toBe(4);
    const fileCalls = fakes.requests('avd').filter(r => r.path === '/files/price.csv');
    expect(fileCalls).toHaveLength(3);
    const oc90 = rows.find(r => r.supplierItemId === ITEM_OC90)!;
    expect(oc90.stock).toEqual([
      { warehouseCode: WH_ZHYTOMYR, warehouseName: 'ЖИТОМИР', qty: 4, isCapped: false },
      { warehouseCode: WH_KYIV, warehouseName: 'КИЇВ', qty: 10, isCapped: true },
    ]);
  });

  // guards: BR-SCON-011
  it('замовлення: кошик → коментар-reference → рядки replace → оформлення; кроки записано по черзі', async () => {
    const { run, persisted } = runner();
    const res = await adapter.placeOrder(conn(), orderInput(), run);
    expect(persisted.map(p => p.step)).toEqual([
      'CART',
      'COMMENT',
      'LINES',
      'CHECKOUT:PENDING',
      'CHECKOUT',
    ]);
    const reqs = fakes.requests('avd');
    expect(reqs.find(r => r.method === 'POST' && r.path === '/api/v1/carts')?.body).toEqual({
      location_uuid: 'loc-1',
    });
    expect(reqs.find(r => r.method === 'PATCH')?.body).toEqual({
      customer_comment: 'STO-ЗП-2026-000001-1',
    });
    expect(reqs.find(r => r.path.endsWith('/lines') && r.method === 'POST')?.body).toEqual({
      operation: 'replace',
      lines: [
        { item_uuid: ITEM_OC90, warehouse_uuid: WH_ZHYTOMYR, quantity: 4 },
        { item_uuid: ITEM_W712, warehouse_uuid: WH_ZHYTOMYR, quantity: 2 },
      ],
    });
    expect(reqs.find(r => r.path.endsWith('/checkout'))?.body).toEqual({
      delivery_mode: 'fastest_delivery',
      forwarder_uuid: 'fwd-1',
      recipient_uuid: 'rcp-1',
    });
    expect(res.status).toBe('CONFIRMED');
    expect(res.lines).toEqual([
      expect.objectContaining({ supplierItemId: ITEM_OC90, qtyConfirmed: 4 }),
      expect.objectContaining({ supplierItemId: ITEM_W712, qtyConfirmed: 2 }),
    ]);
    expect(run.state.externalOrderId).toBe(run.state.externalCartId);
  });

  it('часткове підтвердження (сценарій partial) — підтверджена кількість менша за замовлену', async () => {
    fakes.setScenario('avd', 'partial', { times: 1 });
    const res = await adapter.placeOrder(conn(), orderInput(), runner().run);
    expect(res.lines?.map(l => l.qtyConfirmed)).toEqual([2, 1]);
  });

  // guards: BR-SCON-011
  it('повтор після кроку LINES не створює другого кошика й не дублює рядки', async () => {
    const first = runner();
    await first.run.step('CART', { repeatable: true }, async () => {
      const r = await fetch(`${fakes.url}/avd/api/v1/carts`, {
        method: 'POST',
        headers: { 'x-api-key': 'avd-test-key', 'content-type': 'application/json' },
        body: JSON.stringify({ location_uuid: 'loc-1' }),
      });
      const uuid = ((await r.json()) as { data: { cart: { uuid: string } } }).data.cart.uuid;
      return { externalCartId: uuid, externalOrderId: uuid };
    });
    const resumed = runner({ ...first.run.state, step: 'LINES' });
    fakes.state.requests.length = 0;
    await adapter.placeOrder(conn(), orderInput(), resumed.run);
    const reqs = fakes.requests('avd');
    expect(reqs.filter(r => r.method === 'POST' && r.path === '/api/v1/carts')).toHaveLength(0);
    expect(reqs.filter(r => r.path.endsWith('/lines'))).toHaveLength(0);
    expect(reqs.filter(r => r.path.endsWith('/checkout'))).toHaveLength(1);
  });

  // guards: BR-SCON-011
  it('тайм-аут оформлення → крок RECONCILE; звірка за кошиком: оформлено → знайдено, ні → null', async () => {
    fakes.setScenario('avd', 'timeout', { times: 1, path: '/checkout' });
    const short = new AvdTradeAdapter(httpClient([fakes.url], redis).client);
    const { run, persisted } = runner();
    // Тайм-аут клієнта — короткий, щоб тест не чекав 20 с.
    const origRequest = short['http'].request.bind(short['http']);
    short['http'].request = req => origRequest({ ...req, timeoutMs: 300 });
    const err = await short.placeOrder(conn(), orderInput(), run).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupplierReconcileRequired);
    expect(persisted.at(-1)?.step).toBe(RECONCILE_STEP);
    // Фейк не оформив кошик (запит «завис») → замовлення немає.
    await expect(adapter.findOrderByReference(conn(), orderInput(), run.state)).resolves.toBeNull();
    // Оформлення таки дійшло (відповідь загубилась) → звірка знаходить замовлення за uuid кошика.
    await fetch(`${fakes.url}/avd/api/v1/carts/${run.state.externalCartId}/checkout`, {
      method: 'POST',
      headers: { 'x-api-key': 'avd-test-key', 'content-type': 'application/json' },
      body: JSON.stringify({ delivery_mode: 'fastest_delivery', forwarder_uuid: 'fwd-1' }),
    });
    await expect(adapter.findOrderByReference(conn(), orderInput(), run.state)).resolves.toEqual({
      externalOrderId: run.state.externalCartId,
      externalNumber: expect.stringMatching(/^AGS/),
    });
  });

  // guards: BR-SCON-012
  it('статус: рухається з опитуванням → CONFIRMED…READY→SHIPPED, номер і рядки з /orders', async () => {
    const { run } = runner();
    await adapter.placeOrder(conn(), orderInput(), run);
    const seen = [];
    for (let i = 0; i < 4; i++)
      seen.push(await adapter.getOrderStatus(conn(), orderInput(), run.state));
    expect(seen.map(s => s.status)).toEqual(['CONFIRMED', 'CONFIRMED', 'READY', 'SHIPPED']);
    expect(seen[0].externalNumber).toMatch(/^AGS/);
    expect(seen[0].lines).toEqual([
      expect.objectContaining({
        supplierItemId: ITEM_OC90,
        warehouseCode: WH_ZHYTOMYR,
        qtyConfirmed: 4,
      }),
      expect.objectContaining({ supplierItemId: ITEM_W712, qtyConfirmed: 2 }),
    ]);
  });

  // guards: BR-SCON-007
  it('429 → ліміт; квота спільна для підключень того самого контрагента (усі ключі клієнта AVD)', async () => {
    fakes.setScenario('avd', '429', { times: 1, retryAfter: 30 });
    await expect(adapter.verify(conn())).rejects.toBeInstanceOf(SupplierRateLimitError);
    const before = fakes.requests('avd').length;
    await expect(adapter.verify(conn({ id: 'another-connection' }))).rejects.toBeInstanceOf(
      SupplierRateLimitError,
    );
    expect(fakes.requests('avd').length).toBe(before);
  });
});

describe('AVD — чисті мапери', () => {
  // guards: BR-SCON-012
  it('статуси: таблиця документації; невідомий сирий → null', () => {
    expect(mapAvdStatus('Готовий до відвантаження')).toBe('READY');
    expect(mapAvdStatus('Запит на відвантаження')).toBe('PLACED');
    expect(mapAvdStatus('Щось нове')).toBeNull();
  });

  it('CSV прайсу: розділювач «;», лапки, «>10» — нижня межа', () => {
    const rows = parseAvdPriceCsv(
      '﻿uuid;article;brand;name;price;ЖИТОМИР\nu1;"OC;90";MAHLE;Фільтр;127,89;>10\nu2;X1;B;N;0;0\n',
    );
    expect(rows[0]).toMatchObject({ supplierItemId: 'u1', article: 'OC;90', price: 127.89 });
    expect(rows[0].stock).toEqual([
      { warehouseCode: 'ЖИТОМИР', warehouseName: 'ЖИТОМИР', qty: 10, isCapped: true },
    ]);
    expect(rows[1].stock).toEqual([]);
  });
});
