import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startSupplierFakes, type SupplierFakes } from '../../../../../../../tools/supplier-fakes';
import {
  SupplierAuthError,
  SupplierProtocolError,
  SupplierRateLimitError,
  SupplierServerError,
} from '../../http/supplier-errors';
import {
  createPlaceOrderRunner,
  RECONCILE_STEP,
  SupplierReconcileRequired,
} from '../../orders/place-order-runner';
import { connectionCtx, httpClient, OUR_WH } from '../../supplier-api.spec-fixture';
import type { SupplierOrderInput, SupplierOrderState } from '../supplier-adapter.interface';
import { TehnomirAdapter } from './tehnomir.adapter';
import { classifyTehnomirState, tehnomirOfferKey } from './tehnomir.mapper';

/** Одна відповідь на будь-який запит — для тіл, яких фейк не віддає. */
async function localServer(status: number, body: unknown) {
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>(r => server.close(() => r()));
    },
  };
}

/** Контракт адаптера Tehnomir проти фейку (tools/supplier-fakes/providers/tehnomir.js, swagger Tehnomir). */
describe('TehnomirAdapter — контракт проти фейкового Tehnomir', () => {
  let fakes: SupplierFakes;
  let adapter: TehnomirAdapter;

  const conn = (over: Parameters<typeof connectionCtx>[1] = {}) =>
    connectionCtx('TEHNOMIR', {
      apiUrl: `${fakes.url}/tehnomir`,
      credentials: { apiToken: 'tm-test-token' },
      ...over,
    });
  const order = (): SupplierOrderInput => ({
    id: 'so-1',
    reference: 'STO-ЗП-2026-000004-1',
    purchaseOrderNumber: 'ЗП-2026-000004',
    supplierWarehouseCode: null,
    ourWarehouseId: OUR_WH,
    sentAt: null,
    lines: [
      {
        lineId: 'l1',
        supplierItemId: '900',
        offerKey: tehnomirOfferKey('900', 'ABCD'),
        warehouseCode: 'ABCD',
        qty: 3,
        price: 120.22,
        currencyCode: 'UAH',
      },
      {
        lineId: 'l2',
        supplierItemId: '902',
        offerKey: tehnomirOfferKey('902', 'PL22'),
        warehouseCode: 'PL22',
        qty: 1,
        price: 1078,
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
    adapter = new TehnomirAdapter(httpClient([fakes.url]).client);
  });

  // guards: BR-SCON-008
  it('apiToken — у тілі POST; невірний токен (success:false) → авторизація, токен не в тексті', async () => {
    await adapter.verify(conn());
    expect(fakes.requests('tehnomir')[0]).toMatchObject({
      method: 'POST',
      path: '/test/connect',
      body: { apiToken: 'tm-test-token' },
    });
    const err = await adapter
      .verify(conn({ credentials: { apiToken: 'bad-token-xyz' } }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupplierAuthError);
    expect((err as Error).message).not.toContain('bad-token-xyz');
  });

  // guards: BR-SOFR-001
  it('пошук: прайси як склади, MORE — нижня межа, термін і кратність, валюта прайсу; аналоги за прапорцем', async () => {
    const offers = await adapter.search(conn(), {
      article: 'OC90',
      brand: 'MAHLE',
      includeAnalogs: true,
    });
    expect(fakes.requests('tehnomir').find(r => r.path === '/price/search')?.body).toMatchObject({
      code: 'OC90',
      isShowAnalogs: 1,
    });
    expect(offers).toEqual([
      expect.objectContaining({
        supplierItemId: '900',
        warehouseCode: 'ABCD',
        price: 120.22,
        currencyCode: 'UAH',
        qty: 20,
        qtyIsLowerBound: true,
        deliveryDays: 3,
        multiplicity: 1,
        isAnalog: false,
        offerKey: '900|ABCD',
      }),
      expect.objectContaining({
        warehouseCode: 'EU01',
        price: 2.6,
        currencyCode: 'EUR',
        qty: 5,
        qtyIsLowerBound: false,
        deliveryDays: 10,
        multiplicity: 2,
      }),
      expect.objectContaining({ supplierItemId: '901', article: 'W 712/75', isAnalog: true }),
    ]);
    expect(offers[0].deliveryDate).toBeInstanceOf(Date);
  });

  // guards: BR-SCON-011
  it('замовлення: позиції з reference «<ref>-<№>», order/create лише з цими basketIds; чужі позиції кошика лишаються', async () => {
    // Чужа позиція в кошику акаунта (додана з кабінету) не має потрапити в наше замовлення.
    await fetch(`${fakes.url}/tehnomir/basket/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiToken: 'tm-test-token',
        productId: 903,
        priceLogo: 'ABCD',
        quantity: 1,
        reference: 'manual',
      }),
    });
    const { run, persisted } = runner();
    const res = await adapter.placeOrder(conn(), order(), run);
    const adds = fakes
      .requests('tehnomir')
      .filter(
        r => r.path === '/basket/add' && (r.body as { reference?: string }).reference !== 'manual',
      );
    expect(adds.map(a => a.body)).toEqual([
      expect.objectContaining({
        productId: 900,
        priceLogo: 'ABCD',
        quantity: 3,
        reference: 'STO-ЗП-2026-000004-1-1',
      }),
      expect.objectContaining({
        productId: 902,
        priceLogo: 'PL22',
        quantity: 1,
        reference: 'STO-ЗП-2026-000004-1-2',
      }),
    ]);
    const create = fakes.requests('tehnomir').find(r => r.path === '/order/create')!;
    expect(create.body).toMatchObject({
      orderNumber: 'STO-ЗП-2026-000004-1',
      basketIds: [15847522, 15847523],
    });
    expect(fakes.state.data.tehnomir.basket.map((b: { reference: string }) => b.reference)).toEqual(
      ['manual'],
    );
    expect(persisted.map(p => p.step)).toEqual(['BASKET', 'ORDER:PENDING', 'ORDER']);
    expect(res.status).toBe('PLACED');
    expect(run.state.externalOrderId).toBe('3300001');
  });

  // guards: BR-SCON-011
  it('повтор кроку BASKET не додає позицію вдруге (reference уже в кошику)', async () => {
    const { run } = runner();
    await run.step('BASKET', { repeatable: true }, async () => {
      await adapter['call'](conn(), '/basket/add', {
        productId: 900,
        priceLogo: 'ABCD',
        quantity: 3,
        reference: 'STO-ЗП-2026-000004-1-1',
      });
    });
    const resumed = runner({ ...empty() });
    await adapter.placeOrder(conn(), order(), resumed.run);
    const adds = fakes.requests('tehnomir').filter(r => r.path === '/basket/add');
    expect(adds).toHaveLength(2); // перша позиція — з «попередньої спроби», друга — нова
  });

  // guards: BR-SCON-011
  it('5xx на order/create → RECONCILE; звірка order/search за orderNumber', async () => {
    fakes.setScenario('tehnomir', '500', { times: 1, path: '/order/create' });
    const { run, persisted } = runner();
    await expect(adapter.placeOrder(conn(), order(), run)).rejects.toBeInstanceOf(
      SupplierReconcileRequired,
    );
    expect(persisted.at(-1)?.step).toBe(RECONCILE_STEP);
    await expect(adapter.findOrderByReference(conn(), order())).resolves.toBeNull();
    await adapter.placeOrder(conn(), order(), runner({ ...empty(), step: 'BASKET' }).run);
    await expect(adapter.findOrderByReference(conn(), order())).resolves.toEqual({
      externalOrderId: '3300001',
      externalNumber: '3300001',
    });
  });

  // guards: BR-SCON-012
  it('статус за станами позицій: «В работе» → CONFIRMED, «На складе» → READY, «Выдан» → SHIPPED; відмова зменшує підтверджене', async () => {
    fakes.setScenario('tehnomir', 'partial', { times: 1 });
    const { run } = runner();
    await adapter.placeOrder(conn(), order(), run);
    const statuses = [];
    for (let i = 0; i < 3; i++)
      statuses.push(await adapter.getOrderStatus(conn(), order(), run.state));
    expect(statuses.map(s => s.status)).toEqual(['CONFIRMED', 'READY', 'SHIPPED']);
    expect(statuses[0].lines).toEqual([
      expect.objectContaining({ supplierItemId: '900', warehouseCode: 'ABCD', qtyConfirmed: 2 }),
      expect.objectContaining({ supplierItemId: '902', warehouseCode: 'PL22', qtyConfirmed: 1 }),
    ]);
  });

  // guards: BR-SCON-007
  it('503 — ліміт лише з «Exceeded the allowable limit» у тілі; інша 503 — серверна неоднозначна', async () => {
    // Фейк віддає 503 з тілом «scenario 503» — без ознаки ліміту.
    fakes.setScenario('tehnomir', '503', { times: 1 });
    const plain = await adapter.verify(conn()).catch((e: unknown) => e);
    expect(plain).toBeInstanceOf(SupplierServerError);
    expect(plain).toMatchObject({ ambiguous: true });

    const local = await localServer(503, {
      success: false,
      message: 'Exceeded the allowable limit of requests',
    });
    try {
      const a = new TehnomirAdapter(httpClient([local.url]).client);
      await expect(a.verify(conn({ apiUrl: local.url }))).rejects.toBeInstanceOf(
        SupplierRateLimitError,
      );
    } finally {
      await local.close();
    }
  });

  // guards: BR-SCON-002
  it('success:false на 2xx, що віддзеркалює токен, — у тексті помилки токена немає', async () => {
    const local = await localServer(200, {
      success: false,
      message: 'Unknown product, echo: leak-xyz-123',
    });
    try {
      const a = new TehnomirAdapter(httpClient([local.url]).client);
      const err = await a
        .verify(conn({ apiUrl: local.url, credentials: { apiToken: 'leak-xyz-123' } }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SupplierProtocolError);
      expect((err as Error).message).not.toContain('leak-xyz-123');
    } finally {
      await local.close();
    }
  });

  it('класифікація станів позиції (таблиця — звірити наживо)', () => {
    expect(classifyTehnomirState('Отказ поставщика')).toBe('rejected');
    expect(classifyTehnomirState('Видано клієнту')).toBe('shipped');
    expect(classifyTehnomirState('На складе Киев')).toBe('ready');
    expect(classifyTehnomirState('Заказано у поставщика')).toBe('work');
  });
});
