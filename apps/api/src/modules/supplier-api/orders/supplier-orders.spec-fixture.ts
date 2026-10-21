/**
 * Harness передачі замовлень у API постачальника: поверх `procurementHarness` (справжні списки,
 * PurchaseOrdersService з outbox, таблиці в пам'яті з відкатом) — справжні SupplierOrdersService,
 * SupplierOrderSender, SupplierOrderPoller і виконавець кроків; адаптер — підставний, з
 * лічильниками викликів (неповторюваний крок не має виконатись двічі).
 *
 * Factory, не const: isolate:false.
 */
import { vi } from 'vitest';
import type { Job, Queue } from 'bullmq';
import type { MemRow } from '../../cash/cash.spec-fixture';
import {
  GOOD,
  ORG,
  SUPPLIER,
  WH,
  itemRow,
  procurementHarness,
} from '../../purchase-lists/purchase-lists.spec-fixture';
import type { SettingsService } from '../../settings/settings.service';
import { IntegrationLogService } from '../../integration-logs/integration-log.service';
import { SupplierAdapterRegistry } from '../adapters/supplier-adapter-registry';
import type {
  FoundOrder,
  PlacedOrderResult,
  SupplierAdapter,
  SupplierOrderStatusResult,
} from '../adapters/supplier-adapter.interface';
import { SupplierOrdersService } from './supplier-orders.service';
import { SupplierOrderSender, type SupplierPlaceJob } from './supplier-order-sender';
import { SupplierOrderPoller } from './supplier-order-poller';

export { GOOD, ORG, SUPPLIER, WH, itemRow };
export const CONN = '71111111-1111-4111-8111-111111111111';

export const SETTINGS = {
  currency: 'UAH',
  supplierOrderSendMode: 'MANUAL',
  supplierAnalogPolicy: 'CATALOG_ONLY',
  supplierOfferTtlMinutes: 60,
  supplierOrderPollIntervalMinutes: 30,
};

/** Позиція з пропозицією підключення CONN (знімок як після «Обрати»). */
export const offerItem = (id: string, over: MemRow = {}) =>
  itemRow(id, {
    supplierId: SUPPLIER,
    quantity: 4,
    expectedPrice: 120,
    offerConnectionId: CONN,
    offerKey: 'p1|w1',
    offerSupplierItemId: 'p1',
    offerWarehouseCode: 'w1',
    offerPrice: 120,
    offerCurrencyCode: 'UAH',
    offeredAt: new Date(),
    offerChosenBy: 'MANUAL',
    ...over,
  });

export interface FakeAdapterBehaviour {
  /** Що робить крок CHECKOUT (неповторюваний). */
  checkout?: () => Promise<void>;
  result?: PlacedOrderResult;
  found?: FoundOrder | null;
  status?: SupplierOrderStatusResult;
}

/** Адаптер із двома кроками: CART (повторюваний) і CHECKOUT (неповторюваний). */
export function fakeAdapter(b: FakeAdapterBehaviour = {}) {
  const calls = { cart: 0, checkout: 0, find: 0, status: 0 };
  const adapter = {
    provider: 'AVD_TRADE',
    name: 'Фейк',
    capabilities: {
      search: 'online',
      analogs: false,
      order: 'cart',
      sandbox: false,
      orderPerWarehouse: false,
      requiresWarehouseMapping: false,
    },
    credentialFields: [],
    optionFields: [],
    warehouseFields: [],
    orderSteps: ['CART', 'CHECKOUT'],
    placeOrder: vi.fn(async (_c, _o, run) => {
      await run.step('CART', { repeatable: true }, () => {
        calls.cart += 1;
        return Promise.resolve({ externalCartId: `cart-${calls.cart}` });
      });
      // Як AVD: зовнішній id замовлення з'являється лише після оформлення (BR-SCON-014).
      await run.step('CHECKOUT', { repeatable: false }, async () => {
        calls.checkout += 1;
        await (b.checkout ?? (() => Promise.resolve()))();
        return { externalOrderId: run.state.externalCartId, externalNumber: 'EXT-1' };
      });
      return (
        b.result ?? {
          status: 'CONFIRMED',
          statusRaw: 'ok',
          lines: [{ supplierItemId: 'p1', warehouseCode: 'w1', qtyConfirmed: 4 }],
        }
      );
    }),
    findOrderByReference: vi.fn(() => {
      calls.find += 1;
      return Promise.resolve(b.found === undefined ? null : b.found);
    }),
    getOrderStatus: vi.fn(() => {
      calls.status += 1;
      return Promise.resolve(b.status ?? { statusRaw: 'Готовий', status: 'READY' });
    }),
  } as unknown as SupplierAdapter;
  return { adapter, calls, behaviour: b };
}

export function ordersHarness(
  opts: {
    items?: MemRow[];
    settings?: Partial<typeof SETTINGS>;
    adapter?: SupplierAdapter;
    connection?: MemRow;
    workOrders?: MemRow[];
    parts?: MemRow[];
  } = {},
) {
  const h = procurementHarness({
    items: opts.items ?? [offerItem('i1')],
    workOrders: opts.workOrders,
    parts: opts.parts,
    orgSettings: [
      { orgId: ORG, supplierOrderSendMode: opts.settings?.supplierOrderSendMode ?? 'MANUAL' },
    ],
    supplierConnections: [
      {
        id: CONN,
        orgId: ORG,
        counterpartyId: SUPPLIER,
        provider: 'AVD_TRADE',
        name: 'AVD',
        enabled: true,
        apiUrl: null,
        testMode: false,
        credentials: '{"apiKey":"k"}',
        authState: null,
        options: {},
        deletedAt: null,
        ...(opts.connection ?? {}),
      },
    ],
  });
  const t = h.tables;
  const byId = (name: string, id: unknown) => t[name]?.rows.find(r => r.id === id) ?? null;
  h.addTable(
    'supplierOrderLine',
    [],
    () => ({
      createdAt: new Date(),
      deletedAt: null,
      qtyConfirmed: null,
      priceConfirmed: null,
      statusRaw: null,
      externalLineId: null,
    }),
    { good: r => byId('good', r.goodId) },
  );
  // Таблицю supplierOrder procurementHarness уже додав — підміняємо на таку, що знає зв'язки.
  h.addTable(
    'supplierOrder',
    [],
    () => ({
      createdAt: new Date(),
      deletedAt: null,
      step: null,
      externalCartId: null,
      externalOrderId: null,
      externalNumber: null,
      externalStatusRaw: null,
      sentAt: null,
      confirmedAt: null,
      lastPolledAt: null,
      nextPollAt: null,
      error: null,
    }),
    {
      connection: r => byId('supplierConnection', r.connectionId),
      lines: r =>
        t.supplierOrderLine.rows
          .filter(l => l.supplierOrderId === r.id && l.deletedAt === null)
          .map(l => ({ ...l, good: byId('good', l.goodId) })),
    },
  );
  h.addTable('integrationLog', []);
  // poll-due / sweep обходять організації (forEachActiveOrg).
  h.addTable('organisation', [{ id: ORG, deletedAt: null }]);
  // lockPo — SELECT … FOR UPDATE на замовленні: у пам'яті блокувати нічого.
  const prismaRec = h.prisma as unknown as Record<string, unknown>;
  const origRaw = prismaRec.$queryRaw as (
    s: TemplateStringsArray,
    ...v: unknown[]
  ) => Promise<unknown>;
  const locks: string[] = [];
  prismaRec.$queryRaw = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (
      strings.join('?').includes('FROM purchase_orders') &&
      strings.join('?').includes('FOR UPDATE')
    ) {
      locks.push(String(values[0]));
      return Promise.resolve([{ id: values[0] }]);
    }
    return origRaw(strings, ...values);
  });

  const fa = opts.adapter ? { adapter: opts.adapter } : fakeAdapter();
  const registry = new SupplierAdapterRegistry([fa.adapter]);
  const settings = {
    getOrganisationSettings: vi.fn(() =>
      Promise.resolve({ ...SETTINGS, ...(opts.settings ?? {}) }),
    ),
  } as unknown as SettingsService;
  const queueAdd = vi.fn((_name: string, _data: unknown, _opts: unknown) => Promise.resolve({}));
  // addBulk як у BullMQ: пачка задач одним викликом; кожна — через `queueAdd` (спільні перевірки).
  const queueAddBulk = vi.fn((jobs: Array<{ name: string; data: unknown; opts: unknown }>) =>
    Promise.all(jobs.map(j => queueAdd(j.name, j.data, j.opts))),
  );
  const service = new SupplierOrdersService(
    h.prisma,
    settings,
    registry,
    h.purchaseOrders,
    h.links,
    { add: queueAdd, addBulk: queueAddBulk } as unknown as Queue,
  );
  const integrationLog = new IntegrationLogService(h.prisma);
  const sender = new SupplierOrderSender(h.prisma, registry, integrationLog, settings, service);
  const poller = new SupplierOrderPoller(h.prisma, registry, integrationLog, settings, service);

  const job = (purchaseOrderId: string, attemptsMade = 0) =>
    ({
      name: 'place',
      data: { orgId: ORG, purchaseOrderId },
      attemptsMade,
      opts: { attempts: 10, backoff: { type: 'exponential', delay: 30_000 } },
      moveToDelayed: vi.fn(() => Promise.resolve()),
    }) as unknown as Job<SupplierPlaceJob>;

  /** Замовлення з позицій (create-orders) — DRAFT. */
  const draftFromItems = async (ids: string[] = ['i1']) => {
    const { orders } = await h.orders.createOrders(ORG, ids);
    return orders[0].id;
  };
  const po = (id: string) => t.purchaseOrder.rows.find(r => r.id === id)!;
  const supplierOrders = () => t.supplierOrder.rows;
  const lines = () => t.supplierOrderLine.rows;
  return {
    h,
    t,
    service,
    sender,
    poller,
    registry,
    settings,
    queueAdd,
    queueAddBulk,
    job,
    draftFromItems,
    po,
    supplierOrders,
    lines,
    locks,
    fa,
  };
}
