/**
 * Harness пропозицій постачальників: справжні SupplierOffersService, SupplierOfferSearchWorker,
 * SupplierPriceConverter і ExchangeRatesService над таблицями в пам'яті (`where`, зв'язки й
 * відкат транзакції виконуються по-справжньому, див. cash.spec-fixture). Підставні лише
 * налаштування (значення за замовчуванням з міграції), звірка з каталогом (мапа артикул → товар),
 * товари / бренди (створення аналога) і черга.
 *
 * Factory, не const: isolate:false.
 */
import { vi } from 'vitest';
import type { Queue } from 'bullmq';
import type { PrismaService } from '../../../prisma/prisma.service';
import { memoryTable, type MemRow } from '../../cash/cash.spec-fixture';
import { ExchangeRatesService } from '../../exchange-rates/exchange-rates.service';
import type { SettingsService } from '../../settings/settings.service';
import type { GoodsService } from '../../goods/goods.service';
import type { BrandsService } from '../../brands/brands.service';
import type { GoodMatcherService, GoodMatchResult } from '../../goods/good-matcher.service';
import { IntegrationLogService } from '../../integration-logs/integration-log.service';
import { normalizeArticle } from '../../../common/utils/normalize-article';
import { SupplierAdapterRegistry } from '../adapters/supplier-adapter-registry';
import type { SupplierAdapter } from '../adapters/supplier-adapter.interface';
import { SupplierCatalogService } from '../catalog/supplier-catalog.service';
import { SupplierPriceConverter } from './supplier-price-converter';
import { SupplierOffersService } from './supplier-offers.service';
import { SupplierOfferSearchWorker } from './supplier-offer-search.worker';

export const ORG = '11111111-1111-4111-8111-111111111111';
export const OTHER_ORG = '11111111-1111-4111-8111-999999999999';
export const WH = '21111111-1111-4111-8111-111111111111';
export const GOOD = '31111111-1111-4111-8111-111111111111';
export const GOOD_ANALOG = '31111111-1111-4111-8111-222222222222';
export const GOOD_NO_SKU = '31111111-1111-4111-8111-333333333333';
export const SUP_AVD = '51111111-1111-4111-8111-000000000001';
export const SUP_UTR = '51111111-1111-4111-8111-000000000002';
export const CONN_AVD = '71111111-1111-4111-8111-000000000001';
export const CONN_UTR = '71111111-1111-4111-8111-000000000002';
export const CONN_OFF = '71111111-1111-4111-8111-000000000003';
export const LIST = '81111111-1111-4111-8111-111111111111';
export const ITEM_MANUAL = '91111111-1111-4111-8111-000000000001';
export const ITEM_WO = '91111111-1111-4111-8111-000000000002';
export const ITEM_NO_SKU = '91111111-1111-4111-8111-000000000003';
export const EUR = 'c1111111-1111-4111-8111-000000000002';

export const SETTINGS_DEFAULTS = {
  currency: 'UAH',
  supplierOrderSendMode: 'MANUAL',
  supplierAnalogPolicy: 'CATALOG_ONLY',
  supplierDefaultStrategy: 'OPTIMAL',
  supplierOptimalPriceWeight: 0.7,
  supplierAllowSplit: true,
  supplierAllowAnalogsInAuto: false,
  supplierOfferTtlMinutes: 60,
  supplierOfferRetentionDays: 7,
  supplierOrderPollIntervalMinutes: 30,
  supplierCatalogSyncIntervalMinutes: 360,
  supplierUnknownDeliveryDays: 7,
};

let clock = Date.parse('2026-10-18T08:00:00Z');
export const tick = (): Date => new Date((clock += 1000));

export function itemRow(id: string, over: MemRow = {}): MemRow {
  return {
    id,
    orgId: ORG,
    listId: LIST,
    goodId: GOOD,
    warehouseId: WH,
    quantity: 4,
    receivedQty: 0,
    reservedQty: 0,
    status: 'OPEN',
    source: 'MANUAL',
    workOrderId: null,
    workOrderPartId: null,
    supplierId: null,
    expectedPrice: null,
    purchaseOrderId: null,
    notes: null,
    offerConnectionId: null,
    offerKey: null,
    offerChosenBy: null,
    originalGoodId: null,
    createdAt: tick(),
    deletedAt: null,
    ...over,
  };
}

export function connectionRow(id: string, over: MemRow = {}): MemRow {
  return {
    id,
    orgId: ORG,
    counterpartyId: SUP_UTR,
    provider: 'UTR',
    name: null,
    enabled: true,
    apiUrl: null,
    testMode: false,
    priority: 100,
    defaultDeliveryDays: null,
    credentials: '{"email":"a@b.ua","password":"p"}',
    authState: null,
    options: {},
    catalogSyncedAt: null,
    createdAt: tick(),
    deletedAt: null,
    ...over,
  };
}

export interface OffersHarnessOptions {
  settings?: Partial<typeof SETTINGS_DEFAULTS>;
  items?: MemRow[];
  connections?: MemRow[];
  /** article (нормалізований) → результат звірки. */
  matches?: Record<string, GoodMatchResult>;
  queueAdd?: ReturnType<typeof vi.fn>;
  adapters?: SupplierAdapter[];
  eurRate?: number | null;
}

export function offersHarness(opts: OffersHarnessOptions = {}) {
  const t: Record<string, ReturnType<typeof memoryTable>> = {};
  const byId = (name: string, id: unknown) => t[name]?.rows.find(r => r.id === id) ?? null;
  const add = (
    name: string,
    rows: MemRow[],
    defaults?: () => MemRow,
    rel?: Parameters<typeof memoryTable>[2],
  ) =>
    (t[name] = memoryTable(
      rows,
      defaults ?? (() => ({ createdAt: tick(), deletedAt: null })),
      rel,
    ));

  add('brand', [{ id: 'brand-mahle', orgId: ORG, name: 'MAHLE', deletedAt: null }]);
  add('good', [
    {
      id: GOOD,
      orgId: ORG,
      name: 'Фільтр оливи',
      sku: 'OC 90',
      brandId: 'brand-mahle',
      unit: 'шт',
      unitId: null,
      salePrice: 250,
      purchasePrice: 120,
      goodCategoryId: 'cat-1',
      internalCode: 'Т-1',
      deletedAt: null,
    },
    {
      id: GOOD_ANALOG,
      orgId: ORG,
      name: 'Фільтр MANN',
      sku: 'W712/75',
      brandId: null,
      unit: 'шт',
      unitId: null,
      salePrice: 230,
      purchasePrice: 110,
      goodCategoryId: 'cat-1',
      internalCode: 'Т-2',
      deletedAt: null,
    },
    {
      id: GOOD_NO_SKU,
      orgId: ORG,
      name: 'Без артикула',
      sku: null,
      brandId: null,
      unit: 'шт',
      salePrice: 10,
      deletedAt: null,
    },
  ]);
  const goodWithBrand = (r: MemRow) => {
    const g = byId('good', r.goodId);
    return g ? { ...g, brand: g.brandId ? byId('brand', g.brandId) : null } : null;
  };
  add('counterparty', [
    {
      id: SUP_AVD,
      orgId: ORG,
      type: 'SUPPLIER',
      companyName: 'AVD Trade',
      firstName: null,
      lastName: null,
      deletedAt: null,
    },
    {
      id: SUP_UTR,
      orgId: ORG,
      type: 'SUPPLIER',
      companyName: 'UTR',
      firstName: null,
      lastName: null,
      deletedAt: null,
    },
  ]);
  add('purchaseList', [{ id: LIST, orgId: ORG, number: 'СК-1', status: 'OPEN', deletedAt: null }]);
  add('warehouse', [{ id: WH, orgId: ORG, name: 'Основний склад', deletedAt: null }]);
  add('purchaseOrder', []);
  add('workOrder', []);
  add(
    'purchaseListItem',
    opts.items ?? [
      itemRow(ITEM_MANUAL),
      itemRow(ITEM_WO, { source: 'WORK_ORDER', quantity: 2 }),
      itemRow(ITEM_NO_SKU, { goodId: GOOD_NO_SKU }),
    ],
    () => ({
      createdAt: tick(),
      deletedAt: null,
      receivedQty: 0,
      reservedQty: 0,
      status: 'OPEN',
      purchaseOrderId: null,
    }),
    {
      good: goodWithBrand,
      list: r => byId('purchaseList', r.listId),
      warehouse: r => byId('warehouse', r.warehouseId),
      workOrder: () => null,
      supplier: r => byId('counterparty', r.supplierId),
      purchaseOrder: () => null,
    },
  );
  add(
    'supplierConnection',
    opts.connections ?? [
      connectionRow(CONN_AVD, {
        provider: 'AVD_TRADE',
        counterpartyId: SUP_AVD,
        priority: 10,
        credentials: '{"apiKey":"k"}',
      }),
      connectionRow(CONN_UTR),
      connectionRow(CONN_OFF, { enabled: false, provider: 'BM_PARTS' }),
    ],
    undefined,
    { counterparty: r => byId('counterparty', r.counterpartyId) },
  );
  add('supplierOfferBatch', [], () => ({
    createdAt: tick(),
    completedAt: null,
    deletedAt: null,
    strategy: null,
  }));
  add(
    'supplierOfferRequest',
    [],
    () => ({
      createdAt: tick(),
      deletedAt: null,
      status: 'QUEUED',
      attemptsMade: 0,
      nextRetryAt: null,
      error: null,
      enqueueError: null,
      fromCache: false,
      cacheOfId: null,
      completedAt: null,
      includeAnalogs: true,
    }),
    {
      connection: r => {
        const c = byId('supplierConnection', r.connectionId);
        return c ? { ...c, counterparty: byId('counterparty', c.counterpartyId) } : null;
      },
    },
  );
  add('supplierOffer', [], () => ({ createdAt: tick(), deletedAt: null }), {
    connection: r => byId('supplierConnection', r.connectionId),
  });
  add('supplierCatalogItem', []);
  add('integrationLog', []);
  add('organisationSettings', [{ orgId: ORG, currency: 'UAH' }]);
  add('currency', [
    { id: 'c1111111-1111-4111-8111-000000000001', orgId: ORG, code: 'UAH', deletedAt: null },
    { id: EUR, orgId: ORG, code: 'EUR', deletedAt: null },
  ]);
  add(
    'exchangeRate',
    opts.eurRate === null
      ? []
      : [
          {
            id: 'r1',
            orgId: ORG,
            currencyId: EUR,
            date: new Date('2026-10-17T00:00:00Z'),
            rate: opts.eurRate ?? 45.5,
            coefficient: 1,
            deletedAt: null,
          },
        ],
  );

  const $transaction = vi.fn(async (cb: (tx: unknown) => unknown) => {
    const snapshot = Object.values(t).map(x => x.rows.map(r => structuredClone(r)));
    try {
      return await cb(prisma);
    } catch (e) {
      Object.values(t).forEach((x, i) => x.rows.splice(0, x.rows.length, ...snapshot[i]));
      throw e;
    }
  });
  const prisma = { ...t, $transaction } as unknown as PrismaService;

  const settings = {
    getOrganisationSettings: vi.fn(() =>
      Promise.resolve({ ...SETTINGS_DEFAULTS, ...(opts.settings ?? {}) }),
    ),
  } as unknown as SettingsService;
  const goods = {
    create: vi.fn((orgId: string, dto: MemRow) => {
      const id = `good-new-${t.good.rows.length}`;
      t.good.rows.push({ id, orgId, deletedAt: null, ...dto });
      return Promise.resolve({ id });
    }),
  };
  const brands = {
    resolveByNameOrSynonym: vi.fn((_o: string, raw: string | null) =>
      Promise.resolve(
        t.brand.rows.find(b => normalizeArticle(b.name as string) === normalizeArticle(raw)) ??
          null,
      ),
    ),
  };
  const matches = opts.matches ?? {};
  const matcher = {
    matchMany: vi.fn((_o: string, rows: Array<{ article?: string | null }>) =>
      Promise.resolve(
        rows.map(
          r =>
            matches[normalizeArticle(r.article)] ?? {
              status: 'notFound',
              good: null,
              matchedBy: null,
              candidates: [],
            },
        ),
      ),
    ),
  };
  const queueAdd = opts.queueAdd ?? vi.fn(() => Promise.resolve({}));
  const converter = new SupplierPriceConverter(prisma, new ExchangeRatesService(prisma));
  const service = new SupplierOffersService(
    prisma,
    settings,
    converter,
    goods as unknown as GoodsService,
    brands as unknown as BrandsService,
    { add: queueAdd } as unknown as Queue,
  );
  const registry = new SupplierAdapterRegistry(opts.adapters ?? []);
  const worker = new SupplierOfferSearchWorker(
    prisma,
    registry,
    new SupplierCatalogService(prisma),
    matcher as unknown as GoodMatcherService,
    new IntegrationLogService(prisma),
    service,
  );
  return { t, prisma, service, worker, queueAdd, goods, matcher, settings };
}

export const matched = (goodId: string): GoodMatchResult => ({
  status: 'matched',
  good: { id: goodId, internalCode: null, sku: null, name: '', brandId: null, brandName: null },
  matchedBy: 'articleBrand',
  candidates: [],
});

/** Мінімальна задача BullMQ для обробника. */
export function fakeJob<T>(data: T, attemptsMade = 0) {
  return {
    name: 'search',
    data,
    attemptsMade,
    opts: { attempts: 10, backoff: { type: 'exponential', delay: 30_000 } },
    moveToDelayed: vi.fn(() => Promise.resolve()),
  };
}
