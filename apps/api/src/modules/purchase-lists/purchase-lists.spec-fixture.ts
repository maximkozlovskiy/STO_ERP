/**
 * Harness списків купівлі: справжні сервіси списків, нестачі, хуків, розподілу отриманого,
 * WorkOrdersService/WorkOrderStockEffectsService/InventoryService над таблицями в пам'яті
 * (`memoryDb` з work-order-stock.spec-fixture). `where`/`include` виконуються по-справжньому
 * (зв'язки позиції, списку й рядка наряду описано нижче), `$transaction` відкочує всі таблиці.
 *
 * DI-DRIFT GUARD: нова залежність сервісів списків правиться тут. Factory, не const.
 */
import { vi } from 'vitest';
import type { MemRow } from '../cash/cash.spec-fixture';
import { WorkOrderStockEffectsService } from '../work-orders/work-order-stock-effects.service';
import { WorkOrdersService } from '../work-orders/work-orders.service';
import {
  CLIENT,
  GOOD,
  GOOD_2,
  ORG,
  SUPPLIER,
  WH,
  WH_2,
  memoryDb,
  memoryInventory,
  tick,
  type StockHarnessOptions,
} from '../work-orders/work-order-stock.spec-fixture';
import type { PrismaService } from '../../prisma/prisma.service';
import { PurchaseListLinkService } from './purchase-list-link.service';
import { PurchaseListReceiptService } from './purchase-list-receipt.service';
import { PurchaseShortageService } from './purchase-shortage.service';
import { PurchaseListsService } from './purchase-lists.service';
import { PurchaseListItemsService } from './purchase-list-items.service';
import { PurchaseListOrdersService } from './purchase-list-orders.service';
import { PurchaseOrdersService } from '../purchase-orders/purchase-orders.service';
import { SupplierOrderOutboxService } from '../supplier-api/outbox/supplier-order-outbox.service';

export * from '../work-orders/work-order-stock.spec-fixture';

export const SUPPLIER_2 = '51111111-1111-4111-8111-333333333333';
/** Контрагент-клієнт: постачальником бути не може (BR-CP-001). */
export const CLIENT_ONLY = CLIENT;

export function itemRow(id: string, over: MemRow = {}): MemRow {
  return {
    id,
    orgId: ORG,
    listId: 'list-1',
    goodId: GOOD,
    warehouseId: WH,
    quantity: 1,
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
    createdAt: tick(),
    deletedAt: null,
    ...over,
  };
}

export function listRow(id: string, over: MemRow = {}): MemRow {
  return {
    id,
    orgId: ORG,
    number: `СК-2026-${id.slice(-6)}`,
    name: null,
    status: 'OPEN',
    warehouseId: null,
    notes: null,
    mergedIntoId: null,
    closedAt: null,
    createdAt: tick(),
    updatedAt: new Date('2026-10-17T08:00:00Z'),
    deletedAt: null,
    ...over,
  };
}

export interface ProcurementOptions extends StockHarnessOptions {
  lists?: MemRow[];
  items?: MemRow[];
  purchaseOrders?: MemRow[];
  purchaseOrderLines?: MemRow[];
  /** Передача в API постачальника (BR-PO-011/012): налаштування, підключення, зовнішні замовлення. */
  orgSettings?: MemRow[];
  supplierConnections?: MemRow[];
  supplierOrders?: MemRow[];
}

export function procurementHarness(opts: ProcurementOptions = {}) {
  const db = memoryDb(opts);
  const t = db.tables;
  const byId = (name: string, id: unknown) =>
    id == null ? null : (t[name].rows.find(r => r.id === id) ?? null);

  db.addTable('warehouse', [
    { id: WH, orgId: ORG, name: 'Основний склад', deletedAt: null },
    { id: WH_2, orgId: ORG, name: 'Другий склад', deletedAt: null },
  ]);
  db.addTable('counterparty', [
    { id: SUPPLIER, orgId: ORG, type: 'SUPPLIER', companyName: 'ТОВ Постач', deletedAt: null },
    { id: SUPPLIER_2, orgId: ORG, type: 'BOTH', companyName: 'ФОП Другий', deletedAt: null },
    { id: CLIENT, orgId: ORG, type: 'CLIENT', firstName: 'Іван', deletedAt: null },
  ]);
  // Товари з основного fixture + бажаний постачальник для «Фільтра» (BR-PL-003).
  for (const g of t.good.rows) {
    g.sku = g.id === GOOD ? 'OC-90' : 'BP-1';
    g.internalCode = null;
    g.unit = 'шт';
    g.preferredSupplierId = g.id === GOOD ? SUPPLIER : null;
  }
  db.addTable('counterpartyContract');
  db.addTable(
    'purchaseOrderLine',
    opts.purchaseOrderLines ?? [],
    () => ({ createdAt: tick(), deletedAt: null, receivedQty: 0, unitOfMeasureId: null }),
    { good: r => byId('good', r.goodId) },
  );
  db.addTable(
    'purchaseOrder',
    opts.purchaseOrders ?? [],
    () => ({
      createdAt: tick(),
      updatedAt: new Date(),
      deletedAt: null,
      status: 'DRAFT',
      paidAmount: 0,
      paymentDate: null,
      contractId: null,
      notes: null,
      // Передача в API постачальника — значення за замовчуванням зі схеми (BR-PO-011).
      supplierApiStatus: 'NOT_SENT',
      supplierApiSentAt: null,
      supplierApiError: null,
    }),
    {
      supplier: r => byId('counterparty', r.supplierId),
      warehouse: r => byId('warehouse', r.warehouseId),
      contract: () => null,
      currency: () => null,
      lines: r =>
        t.purchaseOrderLine.rows.filter(l => l.purchaseOrderId === r.id && l.deletedAt === null),
    },
  );
  db.addTable(
    'purchaseList',
    opts.lists ?? [listRow('list-1')],
    () => ({
      createdAt: tick(),
      updatedAt: new Date(),
      deletedAt: null,
      status: 'OPEN',
      name: null,
      warehouseId: null,
      notes: null,
      mergedIntoId: null,
      closedAt: null,
    }),
    {
      warehouse: r => byId('warehouse', r.warehouseId),
      mergedInto: r => byId('purchaseList', r.mergedIntoId),
    },
  );
  db.addTable(
    'purchaseListItem',
    opts.items ?? [],
    () => ({
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
    }),
    {
      list: r => byId('purchaseList', r.listId),
      good: r => byId('good', r.goodId),
      warehouse: r => byId('warehouse', r.warehouseId),
      workOrder: r => byId('workOrder', r.workOrderId),
      supplier: r => byId('counterparty', r.supplierId),
      purchaseOrder: r => byId('purchaseOrder', r.purchaseOrderId),
    },
  );
  db.addTable('organisationSettings', opts.orgSettings ?? []);
  db.addTable('supplierConnection', opts.supplierConnections ?? []);
  db.addTable('supplierOrder', opts.supplierOrders ?? []);
  // Рядки наряду з наряд/товар/склад — для нестачі (фільтр `workOrder: { status }`).
  db.addTable('workOrderPart', t.workOrderPart.rows, undefined, {
    workOrder: r => byId('workOrder', r.workOrderId),
    good: r => byId('good', r.goodId),
    warehouse: r => byId('warehouse', r.warehouseId),
  });

  const prisma = db.prisma as unknown as PrismaService;
  const inventory = memoryInventory(db);
  const links = new PurchaseListLinkService();
  const receipt = new PurchaseListReceiptService(inventory);
  const shortage = new PurchaseShortageService(prisma);
  let seq = 0;
  const docNumbers = {
    next: vi.fn(() => {
      seq += 1;
      return Promise.resolve(`СК-2026-${String(seq).padStart(6, '0')}`);
    }),
  };
  const lists = new PurchaseListsService(prisma, docNumbers as never, shortage);
  const items = new PurchaseListItemsService(prisma, docNumbers as never, inventory, shortage);
  let poSeq = 0;
  const poNumbers = {
    next: vi.fn(() => {
      poSeq += 1;
      return Promise.resolve(`ЗП-2026-${String(poSeq).padStart(6, '0')}`);
    }),
  };
  const supplierSettlements = { createTransaction: vi.fn().mockResolvedValue({}) };
  const outboxEvents = { emit: vi.fn() };
  const purchaseOrders = new PurchaseOrdersService(
    prisma,
    inventory,
    supplierSettlements as never,
    poNumbers as never,
    null as never, // pricingService — розцінка тут не задіяна
    { getDefaultVatRate: vi.fn().mockResolvedValue({ vatMode: 'NONE', vatRate: 0 }) } as never,
    { enqueueInitial: vi.fn().mockResolvedValue(undefined) } as never,
    {
      requireBaseCurrencyId: vi.fn().mockResolvedValue('cur-uah'),
      resolveBaseConversion: vi.fn((_o: string, _c: string, _d: Date, amount: number) =>
        Promise.resolve({ rateUsed: 1, amountBase: amount }),
      ),
    } as never,
    links,
    receipt,
    new SupplierOrderOutboxService(outboxEvents as never),
  );
  const orders = new PurchaseListOrdersService(prisma, purchaseOrders);
  const settlements = { createTransaction: vi.fn().mockResolvedValue({}) };
  const stockEffects = new WorkOrderStockEffectsService(
    prisma,
    inventory,
    settlements as never,
    null as never,
    links,
  );
  const workOrders = new WorkOrdersService(
    prisma,
    stockEffects,
    null as never,
    null as never,
    { record: vi.fn().mockResolvedValue(undefined) } as never,
    null as never,
    null as never,
    { emit: vi.fn() } as never,
    { recalc: vi.fn().mockResolvedValue(undefined) } as never,
    null as never,
    { removeWorkOrderSlots: vi.fn().mockResolvedValue(undefined) } as never,
  );

  const item = (id: string) => t.purchaseListItem.rows.find(r => r.id === id);
  const liveItems = () => t.purchaseListItem.rows.filter(r => r.deletedAt === null);
  const list = (id: string) => t.purchaseList.rows.find(r => r.id === id);
  const netOf = (workOrderId: string, goodId = GOOD, warehouseId = WH) =>
    t.stockMovement.rows
      .filter(
        m =>
          m.documentType === 'WorkOrder' &&
          m.documentId === workOrderId &&
          m.goodId === goodId &&
          m.warehouseId === warehouseId &&
          (m.type === 'RESERVATION' || m.type === 'RESERVATION_RELEASE'),
      )
      .reduce((s, m) => s + Number(m.quantity), 0);
  const reserved = (goodId = GOOD, warehouseId = WH) =>
    Number(
      t.stockItem.rows.find(r => r.goodId === goodId && r.warehouseId === warehouseId)?.reserved ??
        0,
    );
  const reserveFor = (workOrderId: string, quantity: number, goodId = GOOD, warehouseId = WH) =>
    inventory.createMovement(ORG, {
      goodId,
      warehouseId,
      type: 'RESERVATION',
      quantity,
      documentType: 'WorkOrder',
      documentId: workOrderId,
    });

  return {
    ...db,
    prisma,
    inventory,
    links,
    receipt,
    shortage,
    lists,
    items,
    docNumbers,
    settlements,
    stockEffects,
    workOrders,
    purchaseOrders,
    orders,
    poNumbers,
    supplierSettlements,
    outboxEvents,
    item,
    liveItems,
    list,
    netOf,
    reserved,
    reserveFor,
    GOOD_2,
  };
}

export type ProcurementHarness = ReturnType<typeof procurementHarness>;
