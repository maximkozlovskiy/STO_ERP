import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startSupplierFakes, type SupplierFakes } from '../../../../../../../tools/supplier-fakes';
import { SupplierAuthError } from '../../http/supplier-errors';
import {
  createPlaceOrderRunner,
  RECONCILE_STEP,
  SupplierReconcileRequired,
} from '../../orders/place-order-runner';
import { connectionCtx, httpClient, OUR_WH } from '../../supplier-api.spec-fixture';
import type { SupplierOrderInput, SupplierOrderState } from '../supplier-adapter.interface';
import { BmPartsAdapter } from './bm-parts.adapter';
import { bmOfferKey } from './bm-parts.mapper';

/** Контракт адаптера BM Parts проти фейку (tools/supplier-fakes/providers/bm.js, openapi.json BM). */
const KYIV = '81F4005056AC66D611EAD7173350C7AA';
const LVIV = '81F4005056AC66D611EAD7173350C7BB';
const P_OC90 = `BB${'0'.repeat(30)}`;
const P_W712 = `BB${'0'.repeat(29)}1`;

describe('BmPartsAdapter — контракт проти фейкового BM Parts', () => {
  let fakes: SupplierFakes;
  let adapter: BmPartsAdapter;

  const conn = (over: Parameters<typeof connectionCtx>[1] = {}) =>
    connectionCtx('BM_PARTS', {
      apiUrl: `${fakes.url}/bm`,
      credentials: { token: 'bm-test-token' },
      ...over,
    });
  const order = (): SupplierOrderInput => ({
    id: 'so-1',
    reference: 'STO-ЗП-2026-000003-1',
    purchaseOrderNumber: 'ЗП-2026-000003',
    supplierWarehouseCode: KYIV,
    ourWarehouseId: OUR_WH,
    sentAt: null,
    lines: [
      {
        lineId: 'l1',
        supplierItemId: P_OC90,
        offerKey: bmOfferKey(P_OC90, KYIV),
        warehouseCode: KYIV,
        qty: 4,
        price: 125.33,
        currencyCode: 'UAH',
      },
    ],
  });
  const empty = (): SupplierOrderState => ({
    step: null,
    externalCartId: null,
    externalOrderId: null,
    externalNumber: null,
  });
  const runner = (initial = empty()) => {
    const persisted: Array<Partial<SupplierOrderState>> = [];
    return {
      run: createPlaceOrderRunner(adapter.orderSteps, initial, p => {
        persisted.push(p);
        return Promise.resolve();
      }),
      persisted,
    };
  };

  beforeAll(async () => {
    fakes = await startSupplierFakes();
  });
  afterAll(() => fakes.close());
  beforeEach(() => {
    fakes.reset();
    adapter = new BmPartsAdapter(httpClient([fakes.url]).client);
  });

  // guards: BR-SCON-008
  it('токен у Authorization без «Bearer», обов’язковий User-Agent; тестовий режим — X-Test-Mode: 1', async () => {
    await adapter.verify(conn());
    await adapter.verify(conn({ testMode: true, options: { userAgent: 'STO-1234' } }));
    const [plain, test] = fakes.requests('bm');
    expect(plain.headers).toMatchObject({
      authorization: 'bm-test-token',
      'user-agent': 'STO-ERP',
    });
    expect(plain.headers['x-test-mode']).toBeUndefined();
    expect(test.headers).toMatchObject({ 'user-agent': 'STO-1234', 'x-test-mode': '1' });
    await expect(adapter.verify(conn({ credentials: { token: 'bad' } }))).rejects.toBeInstanceOf(
      SupplierAuthError,
    );
  });

  // guards: BR-SOFR-001
  it('пошук strict по всіх складах; «>» — нижня межа; аналоги — з картки товару (analogs_available=1)', async () => {
    const offers = await adapter.search(conn(), {
      article: 'OC90',
      brand: 'MAHLE',
      includeAnalogs: true,
    });
    const s = fakes.requests('bm').find(r => r.path === '/search/products')!;
    expect(s.query).toMatchObject({
      q: 'OC90',
      search_mode: 'strict',
      products_as: 'arr',
      warehouses: 'all',
    });
    expect(fakes.requests('bm').find(r => r.path.startsWith('/product/'))?.query).toMatchObject({
      analogs_available: '1',
    });
    expect(offers).toEqual([
      expect.objectContaining({
        supplierItemId: P_OC90,
        warehouseCode: KYIV,
        qty: 12,
        qtyIsLowerBound: false,
        price: 125.33,
        isAnalog: false,
        offerKey: bmOfferKey(P_OC90, KYIV),
      }),
      expect.objectContaining({
        supplierItemId: P_OC90,
        warehouseCode: LVIV,
        qty: 1,
        qtyIsLowerBound: true,
      }),
      expect.objectContaining({
        supplierItemId: P_W712,
        article: 'W 712/75',
        warehouseCode: KYIV,
        qty: 3,
        isAnalog: true,
      }),
    ]);
  });

  it('без аналогів — картка товару не запитується', async () => {
    await adapter.search(conn(), { article: 'OC90', brand: null, includeAnalogs: false });
    expect(fakes.requests('bm').filter(r => r.path.startsWith('/product/'))).toHaveLength(0);
  });

  // guards: BR-SCON-010
  it('замовлення: кошик складу постачальника → резерв із коментарем-reference; підтверджено reserved', async () => {
    const { run, persisted } = runner();
    const res = await adapter.placeOrder(conn(), order(), run);
    const reqs = fakes.requests('bm');
    expect(reqs.find(r => r.path === '/shopping/carts')?.body).toEqual({
      name: 'STO-ЗП-2026-000003-1',
      comment: 'STO-ЗП-2026-000003-1',
      warehouse: KYIV,
      products: [{ uuid: P_OC90, qnt: 4 }],
    });
    expect(reqs.find(r => r.path === '/shopping/reserve/process')?.body).toEqual({
      order_uuid: run.state.externalCartId,
      warehouse_uuid: KYIV,
      comment: 'STO-ЗП-2026-000003-1',
    });
    expect(persisted.map(p => p.step)).toEqual(['CART', 'RESERVE:PENDING', 'RESERVE']);
    expect(res).toEqual({
      status: 'CONFIRMED',
      statusRaw: 'reserves',
      lines: [{ supplierItemId: P_OC90, qtyConfirmed: 4 }],
    });
  });

  it('з конфігом доставки — відвантаження резерву найближчим рейсом (departures → reserve/process)', async () => {
    const c = conn({ options: { warehouses: { [OUR_WH]: { deliveryConfigUuid: 'DC-1' } } } });
    const { run } = runner();
    await adapter.placeOrder(c, order(), run);
    const ship = fakes.requests('bm').find(r => r.path === '/processing/reserve/process')!;
    expect(ship.body).toMatchObject({
      orders_array: [run.state.externalOrderId],
      delivery_config: 'DC-1',
      warehouse: KYIV,
      key: 'KEY123',
      expired_at: '2026-10-18T10:00:00Z',
      departure_at: '2026-10-18T12:00:00Z',
    });
    expect(run.state).toMatchObject({ step: 'SHIP', externalNumber: 'РН-000777' });
  });

  it('частковий резерв (partial) — підтверджено менше', async () => {
    fakes.setScenario('bm', 'partial', { times: 1 });
    const res = await adapter.placeOrder(conn(), order(), runner().run);
    expect(res.lines).toEqual([{ supplierItemId: P_OC90, qtyConfirmed: 2 }]);
  });

  // guards: BR-SCON-011
  it('5xx на резерві → RECONCILE; звірка шукає резерв за коментарем', async () => {
    fakes.setScenario('bm', '500', { times: 1, path: '/shopping/reserve/process' });
    const { run, persisted } = runner();
    await expect(adapter.placeOrder(conn(), order(), run)).rejects.toBeInstanceOf(
      SupplierReconcileRequired,
    );
    expect(persisted.at(-1)?.step).toBe(RECONCILE_STEP);
    await expect(adapter.findOrderByReference(conn(), order())).resolves.toBeNull();
    await adapter.placeOrder(conn(), order(), runner().run);
    await expect(adapter.findOrderByReference(conn(), order())).resolves.toEqual({
      externalOrderId: expect.stringMatching(/^RES/),
      externalNumber: expect.stringMatching(/^РЗ-/),
    });
  });

  // guards: BR-SCON-012
  it('статус з /shopping/reserves: резерв → CONFIRMED, збирання → READY, немає в списках → null', async () => {
    const { run } = runner();
    await adapter.placeOrder(conn(), order(), run);
    const a = await adapter.getOrderStatus(conn(), order(), run.state);
    expect(a).toMatchObject({ status: 'CONFIRMED', statusRaw: 'reserves:Резерв' });
    const b = await adapter.getOrderStatus(conn(), order(), run.state);
    expect(b).toMatchObject({ status: 'READY', statusRaw: 'picking:Збирання' });
    const c = await adapter.getOrderStatus(conn(), order(), {
      ...run.state,
      externalOrderId: 'gone',
    });
    expect(c).toEqual({ statusRaw: 'not_listed', status: null });
  });
});
