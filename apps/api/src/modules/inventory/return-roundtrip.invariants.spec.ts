import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { InventoryService } from './inventory.service';
import { BatchService } from './batch.service';
import { PricingService } from './pricing.service';
import { SettingsService } from '../settings/settings.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * C2 — стейтфул round-trip WRITEOFF→RETURN проти РЕАЛЬНОГО BatchService + РЕАЛЬНОГО
 * InventoryService (без мока returnToBatch/consumeBatch). Мета: емпірично довести
 * головний money/inventory-інваріант, який unit-специ (з мок-returnToBatch) НЕ перевіряють:
 *
 *   Σ remainingQty(active batches) == StockItem.quantity   — ПІСЛЯ повного реверсу.
 *
 * Ключова перевірка ревʼю (shared-batch): дві WO-частини списують з ОДНІЄЇ партії →
 * restoreBatchesForReturn мусить агрегувати по batchId і повернути РАЗ. Ці тести
 * падають, якщо агрегацію прибрати (по-рядковий виклик → idempotency-guard у returnToBatch
 * ігнорує documentLineId → 2-й рядок no-op → недоповернення → Σ-інваріант ламається).
 *
 * In-memory store імітує Postgres-семантику, важливу для інваріанту: CAS updateMany з
 * where-предикатом (remainingQty gte/lte), increment/decrement, batchConsumption вибірка
 * за (orgId, documentType, documentId, quantity </> 0), stockItem upsert increment.
 */

interface Batch {
  id: string;
  orgId: string;
  goodId: string;
  warehouseId: string;
  receivedQty: number;
  remainingQty: number;
  costPrice: number;
  isActive: boolean;
  createdAt: Date;
  expiryDate: Date | null;
}
interface Consumption {
  id: string;
  orgId: string;
  batchId: string;
  goodId: string;
  quantity: number;
  documentType: string | null;
  documentId: string | null;
  documentLineId: string | null;
}
interface Item {
  orgId: string;
  goodId: string;
  warehouseId: string;
  quantity: number;
  reserved: number;
  deletedAt: Date | null;
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [k, cond] of Object.entries(where)) {
    const v = row[k];
    if (cond !== null && typeof cond === 'object') {
      const c = cond as Record<string, unknown>;
      if ('gt' in c && !(typeof v === 'number' && v > (c.gt as number))) return false;
      if ('gte' in c && !(typeof v === 'number' && v >= (c.gte as number))) return false;
      if ('lt' in c && !(typeof v === 'number' && v < (c.lt as number))) return false;
      if ('lte' in c && !(typeof v === 'number' && v <= (c.lte as number))) return false;
    } else if (v !== cond) {
      return false;
    }
  }
  return true;
}

/** In-memory Prisma-подібний клієнт із семантикою CAS/increment, достатньою для інваріанту. */
function makeStore() {
  const batches: Batch[] = [];
  const consumptions: Consumption[] = [];
  const items: Item[] = [];
  let seq = 0;
  const nid = (p: string) => `${p}-${++seq}`;

  const db = {
    _batches: batches,
    _consumptions: consumptions,
    _items: items,
    stockBatch: {
      findMany: vi.fn(async ({ where, orderBy, take }: any) => {
        let rows = batches.filter(b => matches(b as any, where));
        if (Array.isArray(orderBy) && orderBy[0]?.createdAt) {
          rows = [...rows].sort((a, b) =>
            orderBy[0].createdAt === 'desc'
              ? b.createdAt.getTime() - a.createdAt.getTime()
              : a.createdAt.getTime() - b.createdAt.getTime(),
          );
        }
        return take ? rows.slice(0, take) : rows;
      }),
      findFirst: vi.fn(
        async ({ where }: any) => batches.find(b => matches(b as any, where)) ?? null,
      ),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const rows = batches.filter(b => matches(b as any, where));
        for (const b of rows) {
          if (data.remainingQty?.increment != null) b.remainingQty += data.remainingQty.increment;
          if (data.remainingQty?.decrement != null) b.remainingQty -= data.remainingQty.decrement;
          if (typeof data.isActive === 'boolean') b.isActive = data.isActive;
        }
        return { count: rows.length };
      }),
      create: vi.fn(async ({ data }: any) => {
        const row: Batch = {
          id: data.id ?? nid('b'),
          orgId: data.orgId,
          goodId: data.goodId,
          warehouseId: data.warehouseId,
          receivedQty: data.receivedQty,
          remainingQty: data.remainingQty ?? data.receivedQty,
          costPrice: data.costPrice ?? 0,
          isActive: data.isActive ?? true,
          createdAt: data.createdAt ?? new Date(Date.now() + ++seq),
          expiryDate: data.expiryDate ?? null,
        };
        batches.push(row);
        return row;
      }),
      update: vi.fn(async () => ({})),
    },
    batchConsumption: {
      create: vi.fn(async ({ data }: any) => {
        const row: Consumption = {
          id: nid('c'),
          orgId: data.orgId,
          batchId: data.batchId,
          goodId: data.goodId,
          quantity: data.quantity,
          documentType: data.documentType ?? null,
          documentId: data.documentId ?? null,
          documentLineId: data.documentLineId ?? null,
        };
        consumptions.push(row);
        return row;
      }),
      findFirst: vi.fn(
        async ({ where }: any) => consumptions.find(c => matches(c as any, where)) ?? null,
      ),
      findMany: vi.fn(async ({ where, take }: any) => {
        const rows = consumptions.filter(c => matches(c as any, where));
        return take ? rows.slice(0, take) : rows;
      }),
    },
    stockItem: {
      findFirst: vi.fn(async ({ where }: any) => items.find(i => matches(i as any, where)) ?? null),
      upsert: vi.fn(async ({ where, update, create }: any) => {
        const key = where.orgId_goodId_warehouseId;
        let row = items.find(
          i =>
            i.orgId === key.orgId && i.goodId === key.goodId && i.warehouseId === key.warehouseId,
        );
        if (row) {
          if (update.quantity?.increment != null) row.quantity += update.quantity.increment;
          if (update.reserved?.increment != null) row.reserved += update.reserved.increment;
          row.deletedAt = null;
        } else {
          row = {
            orgId: create.orgId,
            goodId: create.goodId,
            warehouseId: create.warehouseId,
            quantity: create.quantity,
            reserved: create.reserved,
            deletedAt: null,
          };
          items.push(row);
        }
        return { quantity: row.quantity, reserved: row.reserved };
      }),
    },
    stockMovement: {
      create: vi.fn(async ({ data }: any) => ({ id: nid('m'), ...data })),
      update: vi.fn(async () => ({})),
    },
    good: { findFirst: vi.fn(async () => ({ purchasePrice: 50 })) },
    unitOfMeasure: { findFirst: vi.fn(async () => null) },
    // getAvgCost (AVG_COST-орг) — зважена середня по активних партіях товару.
    $queryRaw: vi.fn(async () => {
      const active = batches.filter(b => b.remainingQty > 0);
      const totalCost = active.reduce((s, b) => s + b.remainingQty * b.costPrice, 0);
      const totalQty = active.reduce((s, b) => s + b.remainingQty, 0);
      return [{ total_cost: totalCost, total_qty: totalQty }];
    }),
    // Всі виклики вже передають tx у цьому тесті; passthrough на випадок self-wrap.
    $transaction: vi.fn((cb: any) => (typeof cb === 'function' ? cb(db) : Promise.all(cb))),
  };
  return db;
}

const ORG = 'org-1';
const GOOD = 'good-1';
const WH = 'wh-1';

/** Σ remainingQty по активних партіях товару. */
function sumRemaining(db: ReturnType<typeof makeStore>): number {
  return db._batches
    .filter(b => b.isActive && b.remainingQty > 0)
    .reduce((s, b) => s + b.remainingQty, 0);
}
function stockQty(db: ReturnType<typeof makeStore>): number {
  return db._items.find(i => i.goodId === GOOD && i.warehouseId === WH)?.quantity ?? 0;
}

describe('C2 round-trip WRITEOFF→RETURN — реальний BatchService, Σ-інваріант', () => {
  let inventory: InventoryService;
  let db: ReturnType<typeof makeStore>;

  beforeEach(async () => {
    db = makeStore();
    const settings = {
      getOrganisationSettings: vi.fn().mockResolvedValue({ costMethod: 'FIFO' }),
    };
    const pricing = {
      computePriceFromRules: vi.fn().mockReturnValue(0),
      getActiveRulesForOrg: vi.fn().mockResolvedValue([]),
      calculateSalePrice: vi.fn().mockResolvedValue(0),
    };
    const module = await Test.createTestingModule({
      providers: [
        InventoryService,
        BatchService,
        { provide: PrismaService, useValue: db },
        { provide: SettingsService, useValue: settings },
        { provide: PricingService, useValue: pricing },
      ],
    }).compile();
    inventory = module.get(InventoryService);
  });

  // Прямий засів партій у стор (обходить createFromReceipt-ціноутворення — тут неважливе).
  function seedBatch(id: string, qty: number, createdOffset: number) {
    db._batches.push({
      id,
      orgId: ORG,
      goodId: GOOD,
      warehouseId: WH,
      receivedQty: qty,
      remainingQty: qty,
      costPrice: 50,
      isActive: true,
      createdAt: new Date(2026, 0, 1 + createdOffset),
      expiryDate: null,
    });
    // StockItem — один рядок на (good, warehouse); кілька seedBatch інкрементують quantity.
    const existing = db._items.find(i => i.goodId === GOOD && i.warehouseId === WH);
    if (existing) {
      existing.quantity += qty;
    } else {
      db._items.push({
        orgId: ORG,
        goodId: GOOD,
        warehouseId: WH,
        quantity: qty,
        reserved: 0,
        deletedAt: null,
      });
    }
  }

  async function writeoff(lineId: string, qty: number) {
    await inventory.createMovement(
      ORG,
      {
        goodId: GOOD,
        warehouseId: WH,
        type: 'WRITEOFF',
        quantity: -qty,
        documentType: 'WorkOrder',
        documentId: 'wo-1',
        documentLineId: lineId,
      },
      db as any,
    );
  }
  async function ret(lineId: string, qty: number) {
    await inventory.createMovement(
      ORG,
      {
        goodId: GOOD,
        warehouseId: WH,
        type: 'RETURN',
        quantity: qty,
        documentType: 'WorkOrder',
        documentId: 'wo-1',
        documentLineId: lineId,
      },
      db as any,
    );
  }

  it('shared-batch: 2 частини з ОДНІЄЇ партії → RETURN відновлює РІВНО списане (агрегація)', async () => {
    seedBatch('b1', 10, 0);
    await writeoff('part-A', 4); // remaining 6
    await writeoff('part-B', 3); // remaining 3
    expect(sumRemaining(db)).toBe(3);
    expect(stockQty(db)).toBe(3);

    // RETURN дзеркалить returnPartsAndCredit: per-part RETURN на wo-1.
    await ret('part-A', 4);
    await ret('part-B', 3);

    // Σ remainingQty == StockItem.quantity == початкові 10 (повний реверс).
    expect(stockQty(db)).toBe(10);
    expect(sumRemaining(db)).toBe(10);
    // Партія відновлена рівно до receivedQty — не понад (cap тримає).
    expect(db._batches.find(b => b.id === 'b1')!.remainingQty).toBe(10);
  });

  it('shared-batch: якби агрегацію прибрали — недоповернення (сторож режекту без агрегації)', async () => {
    // Цей тест демонструє, ЧОМУ агрегація потрібна: симулюємо по-рядкове повернення напряму
    // через BatchService.returnToBatch (як зробив би per-line виклик БЕЗ restoreBatchesForReturn).
    seedBatch('b1', 10, 0);
    await writeoff('part-A', 4);
    await writeoff('part-B', 3);
    const batch = new BatchServiceProbe(db);
    // Перший рядок повертає 4 → створює return-consumption (quantity>0) для (b1, WorkOrder, wo-1).
    await batch.returnToBatch(ORG, 'b1', 4, 'WorkOrder', 'wo-1', db as any);
    // Другий рядок (та сама партія/документ) — idempotency-guard бачить існуючий return → no-op.
    await batch.returnToBatch(ORG, 'b1', 3, 'WorkOrder', 'wo-1', db as any);
    // remaining = 3 + 4 = 7 (НЕ 10) → недоповернення на 3. Саме це агрегація й усуває.
    expect(db._batches.find(b => b.id === 'b1')!.remainingQty).toBe(7);
  });

  it('multi-batch span: частина списана через 2 партії → RETURN відновлює обидві', async () => {
    seedBatch('b1', 4, 0); // старіша (FIFO списує першою)
    seedBatch('b2', 10, 1);
    await writeoff('part-A', 6); // b1: 4→0 (вичерпана), b2: 10→8
    expect(stockQty(db)).toBe(8);
    expect(sumRemaining(db)).toBe(8);

    await ret('part-A', 6);
    expect(stockQty(db)).toBe(14);
    expect(sumRemaining(db)).toBe(14);
    expect(db._batches.find(b => b.id === 'b1')!.remainingQty).toBe(4);
    expect(db._batches.find(b => b.id === 'b2')!.remainingQty).toBe(10);
    expect(db._batches.find(b => b.id === 'b1')!.isActive).toBe(true);
  });

  it('multi-part + multi-batch: змішаний сценарій — Σ-інваріант тримається після повного реверсу', async () => {
    seedBatch('b1', 5, 0);
    seedBatch('b2', 5, 1);
    await writeoff('part-A', 3); // b1: 5→2
    await writeoff('part-B', 4); // b1: 2→0, b2: 5→3   (span + shared b1)
    expect(stockQty(db)).toBe(3);
    expect(sumRemaining(db)).toBe(3);

    await ret('part-A', 3);
    await ret('part-B', 4);
    expect(stockQty(db)).toBe(10);
    expect(sumRemaining(db)).toBe(10);
    expect(db._batches.find(b => b.id === 'b1')!.remainingQty).toBe(5);
    expect(db._batches.find(b => b.id === 'b2')!.remainingQty).toBe(5);
  });

  it('AVG_COST org: фізичний декремент FIFO пише реальні consumption → RETURN відновлює', async () => {
    // AVG_COST-орг: consumeBatch викликається з FIFO (фізичний декремент), тож BatchConsumption
    // рядки РЕАЛЬНІ (не пропущені) → restoreBatchesForReturn знаходить і повертає.
    const settings = {
      getOrganisationSettings: vi.fn().mockResolvedValue({ costMethod: 'AVG_COST' }),
    };
    const pricing = {
      computePriceFromRules: vi.fn().mockReturnValue(0),
      getActiveRulesForOrg: vi.fn().mockResolvedValue([]),
      calculateSalePrice: vi.fn().mockResolvedValue(0),
    };
    const module = await Test.createTestingModule({
      providers: [
        InventoryService,
        BatchService,
        { provide: PrismaService, useValue: db },
        { provide: SettingsService, useValue: settings },
        { provide: PricingService, useValue: pricing },
      ],
    }).compile();
    const inv = module.get<InventoryService>(InventoryService);

    seedBatch('b1', 8, 0);
    await inv.createMovement(
      ORG,
      {
        goodId: GOOD,
        warehouseId: WH,
        type: 'WRITEOFF',
        quantity: -5,
        documentType: 'WorkOrder',
        documentId: 'wo-1',
        documentLineId: 'p1',
      },
      db as any,
    );
    expect(stockQty(db)).toBe(3);
    expect(sumRemaining(db)).toBe(3);
    await inv.createMovement(
      ORG,
      {
        goodId: GOOD,
        warehouseId: WH,
        type: 'RETURN',
        quantity: 5,
        documentType: 'WorkOrder',
        documentId: 'wo-1',
        documentLineId: 'p1',
      },
      db as any,
    );
    expect(stockQty(db)).toBe(8);
    expect(sumRemaining(db)).toBe(8);
  });
});

/** Тонкий пробник — інстанціює РЕАЛЬНИЙ BatchService поза Nest DI для одного per-line сценарію. */
class BatchServiceProbe {
  private svc: BatchService;
  constructor(db: ReturnType<typeof makeStore>) {
    this.svc = new BatchService(
      db as unknown as PrismaService,
      {
        computePriceFromRules: () => 0,
        getActiveRulesForOrg: async () => [],
        calculateSalePrice: async () => 0,
      } as unknown as PricingService,
    );
  }
  returnToBatch = (...a: Parameters<BatchService['returnToBatch']>) => this.svc.returnToBatch(...a);
}
