import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startSupplierFakes, type SupplierFakes } from '../../../../../../../tools/supplier-fakes';
import type { PrismaService } from '../../../../prisma/prisma.service';
import { memoryTable } from '../../../cash/cash.spec-fixture';
import { SupplierAuthSession } from '../../auth/supplier-auth.session';
import { SupplierAuthError } from '../../http/supplier-errors';
import {
  createPlaceOrderRunner,
  RECONCILE_STEP,
  SupplierReconcileRequired,
} from '../../orders/place-order-runner';
import {
  CONN,
  connectionCtx,
  fakeRedis,
  httpClient,
  ORG,
  OUR_WH,
} from '../../supplier-api.spec-fixture';
import type { SupplierOrderInput, SupplierOrderState } from '../supplier-adapter.interface';
import { AdUkraineAdapter } from './ad-ukraine.adapter';
import { adOfferKey } from './ad-ukraine.mapper';

/** Контракт адаптера AD Ukraine проти фейку (tools/supplier-fakes/providers/ad.js, swagger eCom v2). */
describe('AdUkraineAdapter — контракт проти фейкового AD', () => {
  let fakes: SupplierFakes;
  let adapter: AdUkraineAdapter;
  let connections: ReturnType<typeof memoryTable>;

  const conn = (over: Parameters<typeof connectionCtx>[1] = {}) =>
    connectionCtx('AD_UKRAINE', {
      apiUrl: `${fakes.url}/ad`,
      credentials: { login: 'ad-login', pwd: 'ad-pwd' },
      options: { company: 'autotechnics' },
      ...over,
    });
  const order = (): SupplierOrderInput => ({
    id: 'so-1',
    reference: 'STO-ЗП-2026-000005-1',
    purchaseOrderNumber: 'ЗП-2026-000005',
    supplierWarehouseCode: 'КИЕВ2',
    ourWarehouseId: OUR_WH,
    sentAt: null,
    lines: [
      {
        lineId: 'l1',
        supplierItemId: 'OC90',
        offerKey: adOfferKey('OC90', 'КИЕВ2'),
        warehouseCode: 'КИЕВ2',
        qty: 4,
        price: 130.45,
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
    connections = memoryTable([{ id: CONN, orgId: ORG, authState: null }]);
    const redis = fakeRedis();
    const session = new SupplierAuthSession(
      { supplierConnection: connections } as unknown as PrismaService,
      redis,
    );
    adapter = new AdUkraineAdapter(httpClient([fakes.url], redis).client, session);
  });

  // guards: BR-SCON-008
  it('логін {login, pwd, company} → JWT з exp у authState; Bearer у запитах; невірний пароль → авторизація', async () => {
    await adapter.verify(conn());
    const [login, locations] = fakes.requests('ad');
    expect(login).toMatchObject({
      path: '/api/v2/ecom/auth/login',
      body: { login: 'ad-login', pwd: 'ad-pwd', company: 'autotechnics' },
    });
    expect(locations.headers.authorization).toMatch(/^Bearer ey/);
    expect(JSON.parse(connections.rows[0].authState as string).expiresAt).toBe(
      '2100-01-01T00:00:00.000Z',
    );
    connections.rows[0].authState = null;
    await expect(
      adapter.verify(conn({ credentials: { login: 'ad-login', pwd: 'nope' } })),
    ).rejects.toBeInstanceOf(SupplierAuthError);
  });

  // guards: BR-SCON-008
  it('401 на кешованому токені → повторний логін (refresh-токена немає) і повтор запиту', async () => {
    await adapter.search(conn(), { article: 'OC90', brand: null, includeAnalogs: false });
    fakes.state.data.ad.tokens = {};
    await expect(
      adapter.search(conn(), { article: 'OC90', brand: null, includeAnalogs: false }),
    ).resolves.toHaveLength(2);
    expect(fakes.requests('ad').filter(r => r.path.endsWith('/auth/login'))).toHaveLength(2);
  });

  // guards: BR-SOFR-001
  it('пошук item/search: склад AD — location, «>10» — нижня межа, ціна клієнта (не роздрібна)', async () => {
    const offers = await adapter.search(conn(), {
      article: 'OC 90',
      brand: 'MAHLE',
      includeAnalogs: true,
    });
    expect(fakes.requests('ad').find(r => r.path.endsWith('/item/search'))?.body).toEqual({
      code: 'OC 90',
    });
    expect(offers).toEqual([
      expect.objectContaining({
        supplierItemId: 'OC90',
        warehouseCode: 'КИЕВ2',
        qty: 10,
        qtyIsLowerBound: true,
        price: 130.45,
        currencyCode: 'UAH',
        isAnalog: false,
        offerKey: 'OC90|КИЕВ2',
      }),
      expect.objectContaining({ warehouseCode: 'ЛЬВОВ', qty: 3, qtyIsLowerBound: false }),
    ]);
  });

  // guards: BR-SCON-010
  it('замовлення: order/create на склад AD з коментарем-reference → docNo', async () => {
    const { run, persisted } = runner();
    const res = await adapter.placeOrder(conn(), order(), run);
    expect(fakes.requests('ad').find(r => r.path.endsWith('/order/create'))?.body).toEqual({
      items: [{ itemNo: 'OC90', quantity: 4 }],
      locationCode: 'КИЕВ2',
      customerComment: 'STO-ЗП-2026-000005-1',
    });
    expect(persisted.map(p => p.step)).toEqual(['CREATE:PENDING', 'CREATE']);
    expect(run.state).toMatchObject({
      externalOrderId: 'ЗК-0000001',
      externalNumber: 'ЗК-0000001',
    });
    expect(res.status).toBe('PLACED');
  });

  // guards: BR-SCON-011
  it('5xx на order/create → RECONCILE; звірка шукає в order/list за customerComment', async () => {
    fakes.setScenario('ad', '500', { times: 1, path: '/order/create' });
    const { run, persisted } = runner();
    await expect(adapter.placeOrder(conn(), order(), run)).rejects.toBeInstanceOf(
      SupplierReconcileRequired,
    );
    expect(persisted.at(-1)?.step).toBe(RECONCILE_STEP);
    await expect(adapter.findOrderByReference(conn(), order())).resolves.toBeNull();
    await adapter.placeOrder(conn(), order(), runner().run);
    await expect(adapter.findOrderByReference(conn(), order())).resolves.toEqual({
      externalOrderId: 'ЗК-0000001',
      externalNumber: 'ЗК-0000001',
    });
  });

  // guards: BR-SCON-011
  it('збій логіну — до неповторюваного кроку: не RECONCILE, а звичайний повтор; 401 на order/create → новий токен поза кроком', async () => {
    fakes.setScenario('ad', '500', { times: 1, path: '/auth/login' });
    const first = runner();
    const err = await adapter.placeOrder(conn(), order(), first.run).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SupplierReconcileRequired);
    expect(first.persisted).toEqual([]);
    expect(fakes.requests('ad').some(r => r.path.endsWith('/order/create'))).toBe(false);

    await adapter.verify(conn()); // токен у кеші
    fakes.state.data.ad.tokens = {}; // постачальник його вже не приймає
    const second = runner();
    await adapter.placeOrder(conn(), order(), second.run);
    expect(second.persisted.map(p => p.step)).toEqual([
      'CREATE:PENDING',
      null,
      'CREATE:PENDING',
      'CREATE',
    ]);
    expect(fakes.requests('ad').filter(r => r.path.endsWith('/order/create'))).toHaveLength(2);
  });

  // guards: BR-SCON-012
  it('статус: словника немає — order/one дає сирий статус і рядки, нормалізований null; зникло з невідвантажених → null', async () => {
    fakes.setScenario('ad', 'partial', { times: 1 });
    const { run } = runner();
    await adapter.placeOrder(conn(), order(), run);
    const a = await adapter.getOrderStatus(conn(), order(), run.state);
    // Не вгадуємо CONFIRMED: невідомий сирий статус нормалізованого не змінює (BR-SCON-012).
    expect(a).toMatchObject({ status: null, statusRaw: '1:Прийнято' });
    expect(a.lines).toEqual([
      expect.objectContaining({ supplierItemId: 'OC90', warehouseCode: 'КИЕВ2', qtyConfirmed: 2 }),
    ]);
    await adapter.getOrderStatus(conn(), order(), run.state);
    await expect(adapter.getOrderStatus(conn(), order(), run.state)).resolves.toEqual({
      statusRaw: 'not_in_unshipped',
      status: null,
    });
  });
});
