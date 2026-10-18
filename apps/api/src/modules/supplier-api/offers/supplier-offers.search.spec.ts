import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { NormalizedOffer, SupplierAdapter } from '../adapters/supplier-adapter.interface';
import {
  SupplierAuthError,
  SupplierNetworkError,
  SupplierRateLimitError,
} from '../http/supplier-errors';
import type { SupplierSearchJob } from './supplier-offer-search.worker';
import {
  CONN_AVD,
  CONN_UTR,
  fakeJob,
  GOOD,
  GOOD_ANALOG,
  ITEM_MANUAL,
  ITEM_NO_SKU,
  ITEM_WO,
  matched,
  offersHarness,
  ORG,
  OTHER_ORG,
} from './supplier-offers.spec-fixture';

/**
 * Пошук пропозицій (BR-SOFR-001…004): batch і запити, кеш у межах TTL, черга, обробник,
 * звірка з каталогом, дзеркало AVD, офлайн-перегляд. Таблиці в пам'яті виконують `where`.
 */
const offer = (over: Partial<NormalizedOffer> = {}): NormalizedOffer => ({
  supplierItemId: '45000',
  article: 'OC 90',
  brand: 'MAHLE',
  name: 'Фільтр оливи',
  price: 134.28,
  currencyCode: 'UAH',
  qty: 4,
  qtyIsLowerBound: false,
  warehouseCode: '6',
  warehouseName: 'Миколаїв',
  deliveryDays: null,
  deliveryDate: null,
  multiplicity: 1,
  isAnalog: false,
  offerKey: '45000|6',
  ...over,
});

function utrAdapter(search: SupplierAdapter['search']): SupplierAdapter {
  return {
    provider: 'UTR',
    name: 'UTR',
    capabilities: {
      search: 'online',
      analogs: false,
      order: 'direct',
      sandbox: false,
      orderPerWarehouse: false,
      requiresWarehouseMapping: true,
    },
    search: vi.fn(search),
  } as unknown as SupplierAdapter;
}
const avdAdapter = {
  provider: 'AVD_TRADE',
  name: 'AVD',
  capabilities: { search: 'mirror', analogs: false },
  search: vi.fn(() => Promise.reject(new Error('не має викликатись'))),
} as unknown as SupplierAdapter;

const run = (
  h: ReturnType<typeof offersHarness>,
  requestId: string,
  attemptsMade = 0,
  token?: string,
) => {
  const job = fakeJob<SupplierSearchJob>({ orgId: ORG, requestId }, attemptsMade);
  return { job, done: h.worker.run(job as unknown as Job<SupplierSearchJob>, token) };
};

describe('Пошук пропозицій — batch і черга (BR-SOFR-002)', () => {
  // guards: BR-SOFR-002
  it('запит на кожну пару «позиція × увімкнене підключення»; позиція без артикула — пропущена', async () => {
    const h = offersHarness();
    const res = await h.service.search(
      ORG,
      { itemIds: [ITEM_MANUAL, ITEM_WO, ITEM_NO_SKU] },
      { role: 'OWNER' },
    );
    const reqs = h.t.supplierOfferRequest.rows;
    expect(reqs).toHaveLength(4); // 2 позиції × 2 увімкнені підключення (BM вимкнено)
    expect(new Set(reqs.map(r => r.connectionId))).toEqual(new Set([CONN_AVD, CONN_UTR]));
    expect(reqs[0]).toMatchObject({
      article: 'OC 90',
      articleNormalized: 'OC90',
      brand: 'MAHLE',
      status: 'QUEUED',
    });
    expect(res).toMatchObject({
      skippedItemIds: [ITEM_NO_SKU],
      queueUnavailable: false,
      noConnections: false,
      done: false,
    });
    expect(h.queueAdd).toHaveBeenCalledTimes(4);
    expect(h.queueAdd).toHaveBeenCalledWith(
      'search',
      { orgId: ORG, requestId: reqs[0].id },
      expect.objectContaining({ attempts: 10, backoff: { type: 'exponential', delay: 30_000 } }),
    );
  });

  // guards: BR-SOFR-002
  it('свіжий виконаний запит того ж підключення, артикулу й бренду — з кешу без задачі; refresh — заново', async () => {
    const h = offersHarness();
    await h.service.search(ORG, { itemIds: [ITEM_MANUAL] });
    for (const r of h.t.supplierOfferRequest.rows)
      Object.assign(r, { status: 'DONE', completedAt: new Date() });
    h.queueAdd.mockClear();
    const second = await h.service.search(ORG, { itemIds: [ITEM_WO] });
    expect(h.queueAdd).not.toHaveBeenCalled();
    const cached = h.t.supplierOfferRequest.rows.slice(2);
    expect(cached.every(r => r.fromCache === true && r.status === 'DONE' && r.cacheOfId)).toBe(
      true,
    );
    expect(second.done).toBe(true);
    await h.service.search(ORG, { itemIds: [ITEM_WO], refresh: true });
    expect(h.queueAdd).toHaveBeenCalledTimes(2);
  });

  // guards: BR-SOFR-002
  it('кеш старший за supplierOfferTtlMinutes не використовується', async () => {
    const h = offersHarness({ settings: { supplierOfferTtlMinutes: 30 } });
    await h.service.search(ORG, { itemIds: [ITEM_MANUAL] });
    for (const r of h.t.supplierOfferRequest.rows) {
      Object.assign(r, { status: 'DONE', completedAt: new Date(Date.now() - 31 * 60_000) });
    }
    h.queueAdd.mockClear();
    await h.service.search(ORG, { itemIds: [ITEM_WO] });
    expect(h.queueAdd).toHaveBeenCalledTimes(2);
  });

  // guards: BR-SCON-006
  it('Redis недоступний → запити лишаються QUEUED з причиною, відповідь — queueUnavailable', async () => {
    const h = offersHarness({ queueAdd: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))) });
    const res = await h.service.search(ORG, { itemIds: [ITEM_MANUAL] });
    expect(res.queueUnavailable).toBe(true);
    expect(
      h.t.supplierOfferRequest.rows.every(
        r => r.status === 'QUEUED' && r.enqueueError === 'ECONNREFUSED',
      ),
    ).toBe(true);
  });

  it('позиція чужої організації — 404; без підключень — порожньо з noConnections', async () => {
    const h = offersHarness({ connections: [] });
    await expect(h.service.search(OTHER_ORG, { itemIds: [ITEM_MANUAL] })).rejects.toThrow(
      /не знайдено/,
    );
    const res = await h.service.search(ORG, { itemIds: [ITEM_MANUAL] });
    expect(res).toMatchObject({ noConnections: true, done: true });
  });
});

describe('Обробник пошуку (BR-SOFR-001, 004)', () => {
  // guards: BR-SOFR-004
  it('пропозиції зберігаються зі звіркою; аналог — збіг з іншим товаром; qty ≤ 0 і price ≤ 0 відкинуто', async () => {
    const h = offersHarness({
      adapters: [
        utrAdapter(() =>
          Promise.resolve([
            offer(),
            offer({
              article: 'W 712/75',
              brand: 'MANN',
              offerKey: '45001|6',
              supplierItemId: '45001',
            }),
            offer({ offerKey: 'x', qty: 0 }),
            offer({ offerKey: 'y', price: 0 }),
          ]),
        ),
        avdAdapter,
      ],
      matches: { OC90: matched(GOOD), W71275: matched(GOOD_ANALOG) },
    });
    await h.service.search(ORG, { itemIds: [ITEM_MANUAL] });
    const req = h.t.supplierOfferRequest.rows.find(r => r.connectionId === CONN_UTR)!;
    await run(h, req.id as string).done;
    expect(req).toMatchObject({ status: 'DONE', error: null });
    expect(
      h.t.supplierOffer.rows.map(o => [o.offerKey, o.isAnalog, o.matchedGoodId, o.matchStatus]),
    ).toEqual([
      ['45000|6', false, GOOD, 'matched'],
      ['45001|6', true, GOOD_ANALOG, 'matched'],
    ]);
  });

  // guards: BR-SOFR-004
  it('без збігу в каталозі: аналог — інший артикул чи позначка постачальника', async () => {
    const h = offersHarness({
      adapters: [
        utrAdapter(() =>
          Promise.resolve([
            offer({ offerKey: 'a' }),
            offer({ article: 'OC90-X', offerKey: 'b' }),
            offer({ offerKey: 'c', isAnalog: true }),
          ]),
        ),
        avdAdapter,
      ],
    });
    await h.service.search(ORG, { itemIds: [ITEM_MANUAL] });
    const req = h.t.supplierOfferRequest.rows.find(r => r.connectionId === CONN_UTR)!;
    await run(h, req.id as string).done;
    expect(h.t.supplierOffer.rows.map(o => [o.offerKey, o.isAnalog, o.matchStatus])).toEqual([
      ['a', false, 'notFound'],
      ['b', true, 'notFound'],
      ['c', true, 'notFound'],
    ]);
  });

  // guards: BR-SCON-015
  it('AVD — пошук по дзеркалу каталогу, без звернення до API', async () => {
    const h = offersHarness({ adapters: [avdAdapter, utrAdapter(() => Promise.resolve([]))] });
    h.t.supplierCatalogItem.rows.push({
      id: 'ci-1',
      orgId: ORG,
      connectionId: CONN_AVD,
      supplierItemId: 'a-1',
      article: 'OC 90',
      articleNormalized: 'OC90',
      brand: 'MAHLE',
      name: 'Фільтр',
      price: 127.89,
      currencyCode: 'UAH',
      stock: [{ warehouseCode: 'w1', warehouseName: 'ЖИТОМИР', qty: 10, isCapped: true }],
      deletedAt: null,
    });
    await h.service.search(ORG, { itemIds: [ITEM_MANUAL] });
    const req = h.t.supplierOfferRequest.rows.find(r => r.connectionId === CONN_AVD)!;
    await run(h, req.id as string).done;
    expect(avdAdapter.search).not.toHaveBeenCalled();
    expect(h.t.supplierOffer.rows).toEqual([
      expect.objectContaining({
        offerKey: 'a-1|w1',
        qty: 10,
        qtyIsLowerBound: true,
        connectionId: CONN_AVD,
      }),
    ]);
  });

  // guards: BR-SCON-006
  it('невірні креди → FAILED з причиною, UnrecoverableError; batch завершено, коли всі запити закрито', async () => {
    const h = offersHarness({
      adapters: [
        utrAdapter(() =>
          Promise.reject(new SupplierAuthError('UTR', 'UTR 401: Invalid JWT Token', 401)),
        ),
        avdAdapter,
      ],
    });
    const res = await h.service.search(ORG, { itemIds: [ITEM_MANUAL] });
    const [avdReq, utrReq] = [CONN_AVD, CONN_UTR].map(c =>
      h.t.supplierOfferRequest.rows.find(r => r.connectionId === c)!,
    );
    await expect(run(h, utrReq.id as string).done).rejects.toBeInstanceOf(UnrecoverableError);
    expect(utrReq).toMatchObject({ status: 'FAILED', error: 'UTR 401: Invalid JWT Token' });
    expect(h.t.supplierOfferBatch.rows[0].completedAt).toBeNull();
    await run(h, avdReq.id as string).done;
    expect(h.t.supplierOfferBatch.rows[0].completedAt).toBeInstanceOf(Date);
    expect((await h.service.getBatch(ORG, res.id, 'OWNER')).done).toBe(true);
  });

  // guards: BR-SOFR-002
  it('немає зв’язку → RETRYING з часом наступної спроби (для «повтор о HH:MM»)', async () => {
    const h = offersHarness({
      adapters: [
        utrAdapter(() =>
          Promise.reject(new SupplierNetworkError('UTR', "UTR: немає зв'язку", false)),
        ),
        avdAdapter,
      ],
    });
    const res = await h.service.search(ORG, { itemIds: [ITEM_MANUAL] });
    const utrReq = h.t.supplierOfferRequest.rows.find(r => r.connectionId === CONN_UTR)!;
    await expect(run(h, utrReq.id as string, 2).done).rejects.toBeInstanceOf(SupplierNetworkError);
    expect(utrReq.status).toBe('RETRYING');
    expect((utrReq.nextRetryAt as Date).getTime()).toBeGreaterThan(Date.now() + 100_000); // 30 с × 2²
    const batch = await h.service.getBatch(ORG, res.id, 'OWNER');
    const chip = batch.items[0].requests.find(r => r.connectionId === CONN_UTR)!;
    expect(chip).toMatchObject({ status: 'RETRYING', error: "UTR: немає зв'язку" });
    expect(chip.nextRetryAt).not.toBeNull();
  });

  // guards: BR-SCON-007
  it('ліміт → задача відкладається, запит RETRYING до скидання квоти', async () => {
    const h = offersHarness({
      adapters: [
        utrAdapter(() => Promise.reject(new SupplierRateLimitError('UTR', 'UTR 429', 60_000))),
        avdAdapter,
      ],
    });
    await h.service.search(ORG, { itemIds: [ITEM_MANUAL] });
    const utrReq = h.t.supplierOfferRequest.rows.find(r => r.connectionId === CONN_UTR)!;
    const { job, done } = run(h, utrReq.id as string, 0, 'tok');
    await expect(done).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'tok');
    expect(utrReq.status).toBe('RETRYING');
  });
});

describe('Офлайн: останні відомі пропозиції позиції (BR-SOFR-003)', () => {
  // guards: BR-SOFR-003
  it('найсвіжіший виконаний запит підключення; новий незавершений не ховає старих пропозицій; застарілі — stale', async () => {
    const h = offersHarness({
      adapters: [utrAdapter(() => Promise.resolve([offer()])), avdAdapter],
      settings: { supplierOfferTtlMinutes: 5 },
    });
    await h.service.search(ORG, { itemIds: [ITEM_MANUAL] });
    const utrReq = h.t.supplierOfferRequest.rows.find(r => r.connectionId === CONN_UTR)!;
    await run(h, utrReq.id as string).done;
    // Пропозиції отримано 10 хв тому, а новий пошук ще в черзі (немає мережі).
    utrReq.completedAt = new Date(Date.now() - 10 * 60_000);
    h.t.supplierOffer.rows[0].fetchedAt = utrReq.completedAt;
    await h.service.search(ORG, { itemIds: [ITEM_MANUAL], refresh: true });
    const view = await h.service.itemOffers(ORG, ITEM_MANUAL, 'STOREKEEPER');
    const utr = view.requests.find(r => r.connectionId === CONN_UTR)!;
    expect(utr).toMatchObject({ status: 'DONE', stale: true });
    expect(utr.offers).toEqual([
      expect.objectContaining({
        offerKey: '45000|6',
        stale: true,
        price: 134.28,
        priceUah: 134.28,
      }),
    ]);
  });
});
