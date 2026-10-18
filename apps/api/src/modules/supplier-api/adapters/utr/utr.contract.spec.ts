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
import { UtrAdapter } from './utr.adapter';
import { mapUtrStatus, utrExpiresAt, utrOfferKey } from './utr.mapper';

/** Контракт адаптера UTR проти фейку (tools/supplier-fakes/providers/utr.js, вікі api.utr.ua). */
describe('UtrAdapter — контракт проти фейкового UTR', () => {
  let fakes: SupplierFakes;
  let adapter: UtrAdapter;
  let connections: ReturnType<typeof memoryTable>;

  const conn = (over: Parameters<typeof connectionCtx>[1] = {}) =>
    connectionCtx('UTR', {
      apiUrl: `${fakes.url}/utr`,
      credentials: { email: 'utr@test.ua', password: 'utr-pass' },
      options: { warehouses: { [OUR_WH]: { deliveryPointId: '22', transporterId: '3' } } },
      ...over,
    });

  const order = (): SupplierOrderInput => ({
    id: 'so-1',
    reference: 'STO-ЗП-2026-000002-1',
    purchaseOrderNumber: 'ЗП-2026-000002',
    supplierWarehouseCode: null,
    ourWarehouseId: OUR_WH,
    sentAt: null,
    lines: [
      {
        lineId: 'l1',
        supplierItemId: '45000',
        offerKey: utrOfferKey('45000', '15'),
        warehouseCode: '15',
        qty: 3,
        price: 134.28,
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
    adapter = new UtrAdapter(httpClient([fakes.url], redis).client, session);
  });

  // guards: BR-SCON-008
  it('verify: логін з browser_fingerprint, токен — у authState; невірний пароль (412) → авторизація', async () => {
    await adapter.verify(conn());
    const login = fakes.requests('utr').find(r => r.path === '/api/login_check')!;
    expect(login.query.browser_fingerprint).toBe(`sto-erp-${CONN}`);
    expect(login.body).toEqual({ email: 'utr@test.ua', password: 'utr-pass' });
    expect(JSON.parse(connections.rows[0].authState as string)).toMatchObject({
      accessToken: 'utr-token-1',
      refreshToken: 'utr-refresh-1',
    });
    connections.rows[0].authState = null;
    const err = await adapter
      .verify(conn({ credentials: { email: 'utr@test.ua', password: 'wrong' } }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupplierAuthError);
    expect((err as Error).message).not.toContain('wrong');
  });

  // guards: BR-SOFR-001
  it('пошук: артикул у шляху (encode), бренд у query; «> 10» — нижня межа; ключ = товар|склад', async () => {
    const offers = await adapter.search(conn(), {
      article: 'OC 90',
      brand: 'MAHLE',
      includeAnalogs: true,
    });
    const req = fakes.requests('utr').find(r => r.path.startsWith('/api/search/'))!;
    expect(req.path).toBe('/api/search/OC%2090');
    expect(req.query.brand).toBe('MAHLE');
    expect(req.headers.authorization).toBe('Bearer utr-token-1');
    expect(offers).toEqual([
      expect.objectContaining({
        supplierItemId: '45000',
        warehouseCode: '6',
        qty: 4,
        qtyIsLowerBound: false,
        price: 134.28,
        currencyCode: 'UAH',
        offerKey: '45000|6',
        isAnalog: false,
      }),
      expect.objectContaining({
        warehouseCode: '15',
        qty: 10,
        qtyIsLowerBound: true,
        offerKey: '45000|15',
      }),
    ]);
  });

  // guards: BR-SCON-008
  it('401 «Expired JWT Token» → оновлення refresh-токеном і повтор запиту (без нового логіну)', async () => {
    await adapter.search(conn(), { article: 'OC90', brand: null, includeAnalogs: false });
    fakes.state.data.utr.expireTokens = true;
    const offers = await adapter.search(conn(), {
      article: 'OC90',
      brand: null,
      includeAnalogs: false,
    });
    expect(offers.length).toBeGreaterThan(0);
    const paths = fakes.requests('utr').map(r => r.path);
    expect(paths.filter(p => p === '/api/login_check')).toHaveLength(1);
    expect(paths.filter(p => p === '/api/token/refresh')).toHaveLength(1);
  });

  // guards: BR-SCON-010
  it('замовлення: варіант доставки → order/accept з коментарем-reference; підтверджені рядки', async () => {
    const { run, persisted } = runner();
    const res = await adapter.placeOrder(conn(), order(), run);
    const reqs = fakes.requests('utr');
    const deliveries = reqs.find(r => r.path.startsWith('/api/deliveries/'))!;
    expect(deliveries.path).toMatch(/^\/api\/deliveries\/\d{4}-\d{2}-\d{2}\/22\/3$/);
    expect(deliveries.body).toEqual({ storages: [15] });
    const accept = reqs.find(r => r.path === '/api/order/accept')!;
    expect(accept.body).toEqual([
      expect.objectContaining({
        comment: 'STO-ЗП-2026-000002-1',
        delivery: 850,
        deliveryPoint: 22,
        items: [{ detail: 45000, quantity: 3, storage: 15 }],
        paymentType: 'beznal',
        withoutDocument: false,
      }),
    ]);
    expect(persisted.map(p => p.step)).toEqual(['ACCEPT:PENDING', 'ACCEPT']);
    expect(run.state.externalOrderId).toBe('6802274');
    expect(run.state.externalNumber).toBe('УЭТ000001');
    expect(res).toMatchObject({ status: 'CONFIRMED', statusRaw: 'processing' });
    expect(res.lines).toEqual([
      expect.objectContaining({ supplierItemId: '45000', warehouseCode: '15', qtyConfirmed: 3 }),
    ]);
  });

  // guards: BR-SCON-011
  it('5xx на order/accept → RECONCILE; звірка за коментарем у order-list', async () => {
    fakes.setScenario('utr', '500', { times: 1, path: '/api/order/accept' });
    const { run, persisted } = runner();
    await expect(adapter.placeOrder(conn(), order(), run)).rejects.toBeInstanceOf(
      SupplierReconcileRequired,
    );
    expect(persisted.at(-1)?.step).toBe(RECONCILE_STEP);
    await expect(adapter.findOrderByReference(conn(), order())).resolves.toBeNull();
    await adapter.placeOrder(conn(), order(), runner().run);
    await expect(adapter.findOrderByReference(conn(), order())).resolves.toEqual({
      externalOrderId: '6802274',
      externalNumber: 'УЭТ000001',
    });
  });

  // guards: BR-SCON-011
  it('401 на order/accept — оновлення токена поза неповторюваним кроком: збій refresh не дає хибної звірки', async () => {
    const steps: Array<string | null | undefined> = [];
    const run = createPlaceOrderRunner(adapter.orderSteps, empty(), p => {
      steps.push(p.step);
      if (p.step === 'ACCEPT:PENDING' && steps.length === 1) {
        // Токен «спливає» саме на оформленні, а оновлення падає 5xx.
        fakes.state.data.utr.expireTokens = true;
        fakes.setScenario('utr', '500', { times: 1, path: '/api/token/refresh' });
      }
      return Promise.resolve();
    });
    const err = await adapter.placeOrder(conn(), order(), run).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SupplierReconcileRequired);
    expect(steps).toEqual(['ACCEPT:PENDING', null]);
    expect(fakes.requests('utr').filter(r => r.path === '/api/order/accept')).toHaveLength(1);
  });

  // guards: BR-SCON-012
  it('статус: processing → CONFIRMED; невідомий сирий статус → null (нормалізований не змінюється)', async () => {
    const { run } = runner();
    await adapter.placeOrder(conn(), order(), run);
    const first = await adapter.getOrderStatus(conn(), order(), run.state);
    expect(first).toMatchObject({
      status: 'CONFIRMED',
      statusRaw: 'processing',
      externalNumber: 'УЭТ000001',
    });
    const second = await adapter.getOrderStatus(conn(), order(), run.state);
    expect(second).toMatchObject({ status: null, statusRaw: 'shipped_unknown' });
  });

  it('мапери: статус без регістру; expires_at — київський час', () => {
    expect(mapUtrStatus('Processing')).toBe('CONFIRMED');
    expect(mapUtrStatus(undefined)).toBeNull();
    expect(utrExpiresAt('2026-07-17 15:04:50')).toBe('2026-07-17T12:04:50.000Z');
    expect(utrExpiresAt('2026-01-17 15:04:50')).toBe('2026-01-17T13:04:50.000Z');
    expect(utrExpiresAt('nope')).toBeNull();
  });
});
