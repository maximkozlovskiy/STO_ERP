/**
 * Harness резерву наряду (BR-WO-021, BR-INVT-018): справжні `WorkOrdersService`,
 * `WorkOrderStockEffectsService` і `InventoryService` над таблицями в пам'яті (`memoryTable`).
 *
 * Резерв — це рухи `RESERVATION`/`RESERVATION_RELEASE` у таблиці рухів і лічильник `reserved` рядка
 * складу; обидва пише справжній InventoryService, тож тест бачить net-резерв наряду й агрегат складу,
 * а не форму виклику. `$transaction` знімає знімок усіх таблиць і відновлює його при винятку.
 * `$queryRaw` розуміє лише блокування нарядів (`lockWorkOrdersForUpdate`) і пише його в журнал
 * `locks` — порядок блокувань «наряд → склад» перевіряється за журналом подій `events`.
 *
 * Партії (BatchService) — заглушка: собівартість і партії тут не перевіряються.
 * DI-DRIFT GUARD: нова залежність WorkOrdersService / WorkOrderStockEffectsService правиться тут.
 * Factory, не const: `isolate: false` без `clearMocks`.
 */
import { vi } from 'vitest';
import {
  memoryTable,
  whereMatches,
  type MemRelations,
  type MemRow,
  type MemoryTable,
} from '../cash/cash.spec-fixture';
import { InventoryService } from '../inventory/inventory.service';
import { WorkOrderStockEffectsService } from './work-order-stock-effects.service';
import { WorkOrdersService } from './work-orders.service';
import { PurchaseListLinkService } from '../purchase-lists/purchase-list-link.service';
import type { PrismaService } from '../../prisma/prisma.service';

export const ORG = '11111111-1111-4111-8111-111111111111';
export const OTHER_ORG = '11111111-1111-4111-8111-999999999999';
export const WH = '21111111-1111-4111-8111-111111111111';
export const WH_2 = '21111111-1111-4111-8111-222222222222';
export const GOOD = '31111111-1111-4111-8111-111111111111';
export const GOOD_2 = '31111111-1111-4111-8111-222222222222';
export const UOM_PACK = '41111111-1111-4111-8111-111111111111';
export const WO_A = '61111111-1111-4111-8111-111111111111';
export const WO_B = '61111111-1111-4111-8111-222222222222';
export const CLIENT = '51111111-1111-4111-8111-111111111111';
export const SUPPLIER = '51111111-1111-4111-8111-222222222222';

let clock = Date.parse('2026-10-17T08:00:00.000Z');
/** Монотонний час створення рядків — FIFO у тестах не залежить від порядку вставки. */
export const tick = (): Date => new Date((clock += 1000));

export function woRow(id: string, over: MemRow = {}): MemRow {
  return {
    id,
    orgId: ORG,
    number: `НРД-${id.slice(-2)}`,
    status: 'DRAFT',
    counterpartyId: CLIENT,
    vehicleId: 'v-1',
    branchId: 'b-1',
    repairCategory: null,
    outMileage: null,
    totalAmount: 1000,
    paidAmount: 0,
    currencyId: null,
    documentDate: new Date('2026-10-17'),
    plannedAt: null,
    createdAt: tick(),
    deletedAt: null,
    ...over,
  };
}

export function partRow(id: string, workOrderId: string, over: MemRow = {}): MemRow {
  return {
    id,
    orgId: ORG,
    workOrderId,
    goodId: GOOD,
    warehouseId: WH,
    quantity: 1,
    price: 100,
    amount: 100,
    unitOfMeasureId: null,
    createdAt: tick(),
    deletedAt: null,
    ...over,
  };
}

export interface StockHarnessOptions {
  workOrders?: MemRow[];
  parts?: MemRow[];
  /** Фізичний залишок: `{ [goodId|warehouseId]: quantity }`; резерв — 0. */
  stock?: Record<string, number>;
  /** Коефіцієнти одиниць товару (GoodUoM). */
  goodUoMs?: MemRow[];
}

/** Таблиці й `prisma` у пам'яті; розширюється іншими fixture-ами (списки купівлі, замовлення). */
export function memoryDb(opts: StockHarnessOptions = {}) {
  const tables: Record<string, MemoryTable> = {};
  const add = (
    name: string,
    rows: MemRow[] = [],
    defaults?: () => MemRow,
    relations?: MemRelations,
  ) => {
    tables[name] = memoryTable(
      rows,
      defaults ?? (() => ({ createdAt: tick(), deletedAt: null })),
      relations,
    );
    return tables[name];
  };
  // Зв'язки, які читає відповідь переходу наряду (toDto, подія COMPLETED).
  add('workOrder', opts.workOrders ?? [], undefined, {
    vehicle: () => ({ make: 'Skoda', model: 'Octavia', licensePlate: 'AA0000AA' }),
    counterparty: () => ({
      firstName: 'Іван',
      lastName: 'Клієнт',
      companyName: null,
      phone: null,
      email: null,
    }),
    branch: () => ({ name: 'Філія' }),
    contract: () => null,
    currency: () => null,
    lift: () => null,
    // `_count: { select: { purchaseListItems: { where } } }` — позиції списків купівлі наряду
    // (картка наряду, BR-PL-015); `where` виконується по-справжньому.
    _count: (r, arg) => {
      const sel = (arg as { select?: { purchaseListItems?: boolean | { where?: unknown } } })
        ?.select?.purchaseListItems;
      if (!sel) return {};
      const where = typeof sel === 'object' ? sel.where : undefined;
      return {
        purchaseListItems: (tables.purchaseListItem?.rows ?? []).filter(
          i => i.workOrderId === r.id && whereMatches(i, where),
        ).length,
      };
    },
  });
  add('workOrderPart', opts.parts ?? []);
  add('goodUoM', opts.goodUoMs ?? []);
  add(
    'stockItem',
    Object.entries(opts.stock ?? {}).map(([key, quantity], i) => {
      const [goodId, warehouseId] = key.split('|');
      return {
        id: `si-${i}`,
        orgId: ORG,
        goodId,
        warehouseId,
        quantity,
        reserved: 0,
        deletedAt: null,
      };
    }),
    () => ({ quantity: 0, reserved: 0, deletedAt: null }),
  );
  add('stockMovement', [], () => ({ createdAt: tick() }));
  add('good', [
    { id: GOOD, orgId: ORG, name: 'Фільтр масляний', purchasePrice: 50, deletedAt: null },
    { id: GOOD_2, orgId: ORG, name: 'Колодки', purchasePrice: 80, deletedAt: null },
  ]);
  add('unitOfMeasure', []);
  add('completionAct');
  add('purchaseList');
  add('purchaseListItem', [], () => ({
    createdAt: tick(),
    deletedAt: null,
    receivedQty: 0,
    reservedQty: 0,
    status: 'OPEN',
    purchaseOrderId: null,
    workOrderId: null,
    workOrderPartId: null,
    supplierId: null,
    expectedPrice: null,
    notes: null,
  }));
  add('purchaseOrder');
  add('purchaseOrderLine');
  add('calendarSlot');

  /** Журнал подій у порядку виклику: `lock:<woId>`, `<тип руху>:<goodId>`. */
  const events: string[] = [];
  const locks: string[][] = [];
  const movementCreate = tables.stockMovement.create.getMockImplementation()!;
  tables.stockMovement.create.mockImplementation((args: { data: MemRow }) => {
    events.push(`${String(args.data.type)}:${String(args.data.goodId)}`);
    return movementCreate(args);
  });

  const $queryRaw = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (sql.includes('FROM work_orders') && sql.includes('FOR UPDATE')) {
      const [orgId, ids] = values as [string, string[]];
      locks.push(ids);
      for (const id of ids) events.push(`lock:${id}`);
      return Promise.resolve(
        tables.workOrder.rows
          .filter(r => r.orgId === orgId && ids.includes(r.id as string))
          .map(r => ({ id: r.id })),
      );
    }
    return Promise.reject(new Error(`$queryRaw у пам'яті не знає запиту: ${sql}`));
  });

  const $transaction = vi.fn(async (cb: (tx: unknown) => unknown) => {
    const snapshot = Object.values(tables).map(t => t.rows.map(r => structuredClone(r)));
    try {
      return await cb(prisma);
    } catch (e) {
      Object.values(tables).forEach((t, i) => t.rows.splice(0, t.rows.length, ...snapshot[i]));
      throw e;
    }
  });
  const prisma: Record<string, unknown> = { ...tables, $queryRaw, $transaction };
  /** Нова таблиця після створення (для розширень fixture). */
  const addTable = (
    name: string,
    rows: MemRow[] = [],
    defaults?: () => MemRow,
    relations?: MemRelations,
  ) => {
    const t = add(name, rows, defaults, relations);
    prisma[name] = t;
    return t;
  };
  return { tables, prisma, events, locks, addTable };
}

export type MemoryDb = ReturnType<typeof memoryDb>;

/** Справжній InventoryService над таблицями в пам'яті; партії — заглушка. */
export function memoryInventory(db: MemoryDb): InventoryService {
  const batches = {
    createFromReceipt: vi.fn().mockResolvedValue(undefined),
    consumeBatch: vi.fn().mockResolvedValue([]),
    getAvgCost: vi.fn().mockResolvedValue(null),
    returnToBatch: vi.fn().mockResolvedValue(undefined),
  };
  const settings = { getOrganisationSettings: vi.fn().mockResolvedValue({ costMethod: 'FIFO' }) };
  return new InventoryService(
    db.prisma as unknown as PrismaService,
    batches as never,
    settings as never,
  );
}

export function stockHarness(opts: StockHarnessOptions = {}) {
  const db = memoryDb(opts);
  // Справжні хуки списків купівлі (BR-PL-013) над таблицею позицій у пам'яті.
  const purchaseLists = new PurchaseListLinkService();
  const inventory = memoryInventory(db);
  const settlements = { createTransaction: vi.fn().mockResolvedValue({}) };
  const stockEffects = new WorkOrderStockEffectsService(
    db.prisma as unknown as PrismaService,
    inventory,
    settlements as never,
    null as never, // exchangeRates — курсова різниця тут не задіяна
    purchaseLists,
  );
  const service = new WorkOrdersService(
    db.prisma as unknown as PrismaService,
    stockEffects,
    null as never, // docNumbers
    null as never, // pdf
    { record: vi.fn().mockResolvedValue(undefined) } as never, // audit
    null as never, // settingsService
    null as never, // exchangeRates
    { emit: vi.fn() } as never, // events
    { recalc: vi.fn().mockResolvedValue(undefined) } as never, // totals
    null as never, // orgPrintInfo
    { removeWorkOrderSlots: vi.fn().mockResolvedValue(undefined) } as never, // calendar
  );

  const item = (goodId = GOOD, warehouseId = WH) =>
    db.tables.stockItem.rows.find(r => r.goodId === goodId && r.warehouseId === warehouseId);
  /** Агрегат резерву складу. */
  const reserved = (goodId = GOOD, warehouseId = WH) =>
    Number(item(goodId, warehouseId)?.reserved ?? 0);
  /** Net-резерв наряду за рухами (BR-INVT-018). */
  const netOf = (workOrderId: string, goodId = GOOD, warehouseId = WH) =>
    db.tables.stockMovement.rows
      .filter(
        m =>
          m.documentType === 'WorkOrder' &&
          m.documentId === workOrderId &&
          m.goodId === goodId &&
          m.warehouseId === warehouseId &&
          (m.type === 'RESERVATION' || m.type === 'RESERVATION_RELEASE'),
      )
      .reduce((s, m) => s + Number(m.quantity), 0);
  /** Резерв, зроблений «колись раніше» (приймання, BR-PL-011) — тим самим InventoryService. */
  const reserveFor = (workOrderId: string, quantity: number, goodId = GOOD, warehouseId = WH) =>
    inventory.createMovement(ORG, {
      goodId,
      warehouseId,
      type: 'RESERVATION',
      quantity,
      documentType: 'WorkOrder',
      documentId: workOrderId,
    });
  const status = (id: string) => db.tables.workOrder.rows.find(r => r.id === id)?.status;
  return {
    ...db,
    inventory,
    stockEffects,
    service,
    settlements,
    reserved,
    netOf,
    reserveFor,
    status,
    item,
  };
}
