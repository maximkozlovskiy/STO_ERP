import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkOrdersService } from './work-orders.service';
import type { PrismaService } from '../../prisma/prisma.service';

// ─── Regression spec for totalActualLabor (commits 0665024c, ca5aef48) ───────
//
// The feature switched totalAmount from
//   SUM(normoHours × price) + totalParts
// to
//   SUM((actualHours ?? normoHours) × price) + totalParts
//
// This spec drives the PRIVATE recalcTotals() via addPart() (any mutation that
// calls recalcTotals will do — addPart is the simplest path because it doesn't
// require a Work/Employee guard mock). We snapshot the data passed to
// `workOrder.update()` after the in-transaction recalc.
//
// Bugs caught by this spec:
//   #507-A: totalActualLabor regression to a stale formula (e.g. dropping the
//           actualHours fallback chain — `?? normoHours` removed).
//   #507-B: totalAmount returning to `totalLabor + totalParts` instead of
//           `totalActualLabor + totalParts`.
//   #507-C: silently treating `actualHours: 0` as null (?? semantics vs ||).
//   #507-D: empty WO regressing to NaN / undefined totals.

const ORG = '11111111-1111-4111-8111-111111111111';
const WO_ID = '22222222-2222-4222-8222-222222222222';
const GOOD_ID = '33333333-3333-4333-8333-333333333333';
const WAREHOUSE_ID = '44444444-4444-4444-8444-444444444444';

type LineRow = {
  amount: number;
  actualHours: number | null;
  normoHours: number;
  price: number;
};

function makePrismaSpy(lines: LineRow[], partsSum: number) {
  // workOrder.findFirst — addPart parent guard (status: 'DRAFT' so editable)
  const woFindFirst = vi.fn().mockResolvedValue({ status: 'DRAFT' });
  // good.findFirst — salePrice for price default
  const goodFindFirst = vi.fn().mockResolvedValue({ salePrice: 100 });
  // warehouse.findFirst — existence
  const warehouseFindFirst = vi.fn().mockResolvedValue({ id: WAREHOUSE_ID });
  // goodUoM.findFirst — null (no UoM passed)
  const goodUoMFindFirst = vi.fn().mockResolvedValue(null);
  // workOrderPart.create — return a stub part (return value isn't asserted)
  const partCreate = vi.fn().mockResolvedValue({
    id: 'P1',
    workOrderId: WO_ID,
    goodId: GOOD_ID,
    warehouseId: WAREHOUSE_ID,
    quantity: 1,
    price: 100,
    amount: 100,
    createdAt: new Date(),
    good: null,
  });
  // recalcTotals → workOrderLine.findMany + workOrderPart.aggregate + workOrder.update
  const lineFindMany = vi.fn().mockResolvedValue(lines);
  const partAggregate = vi.fn().mockResolvedValue({ _sum: { amount: partsSum } });
  const woUpdate = vi.fn().mockResolvedValue({});

  const tx = {
    workOrder: { update: woUpdate },
    workOrderLine: { findMany: lineFindMany },
    workOrderPart: { create: partCreate, aggregate: partAggregate },
  };

  const prisma = {
    workOrder: { findFirst: woFindFirst },
    good: { findFirst: goodFindFirst },
    warehouse: { findFirst: warehouseFindFirst },
    goodUoM: { findFirst: goodUoMFindFirst },
    // $transaction runs the body with the tx context. addPart uses the
    // callback form: prisma.$transaction(async tx => { ... }).
    $transaction: vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  } as unknown as PrismaService;

  return { prisma, woUpdate, lineFindMany, partAggregate };
}

function makeService(prisma: PrismaService): WorkOrdersService {
  // addPart only touches prisma + inventory.createMovement (not invoked here
  // because we don't transition status). All other deps unused EXCEPT
  // settingsService — recalcTotals reads default VAT rate after summing lines/parts.
  // Bug #536: positional constructor — settingsService at index 9, config at 10.
  const settingsService = {
    getDefaultVatRate: vi.fn().mockResolvedValue({ vatMode: 'NONE', vatRate: 0 }),
  } as never;
  return new WorkOrdersService(
    prisma,
    null as never, // inventory
    null as never, // settlements
    null as never, // docNumbers
    null as never, // pdf
    null as never, // audit
    settingsService, // settingsService (Bug #536)
    null as never, // events (EventEmitter2)
  );
}

describe('WorkOrdersService.recalcTotals — totalActualLabor formula', () => {
  it('empty WO → all totals are 0 (no NaN/undefined regression)', async () => {
    const { prisma, woUpdate } = makePrismaSpy([], 0);
    const service = makeService(prisma);
    await service.addPart(ORG, WO_ID, { goodId: GOOD_ID, warehouseId: WAREHOUSE_ID, quantity: 1 });

    expect(woUpdate).toHaveBeenCalledTimes(1);
    const data = woUpdate.mock.calls[0][0].data;
    expect(data.totalLabor).toBe(0);
    expect(data.totalActualLabor).toBe(0);
    expect(data.totalParts).toBe(0);
    expect(data.totalAmount).toBe(0);
  });

  it('all actualHours=null → totalActualLabor === totalLabor (fallback to normoHours)', async () => {
    const lines: LineRow[] = [
      { amount: 200, actualHours: null, normoHours: 2, price: 100 },
      { amount: 300, actualHours: null, normoHours: 3, price: 100 },
    ];
    const { prisma, woUpdate } = makePrismaSpy(lines, 0);
    const service = makeService(prisma);
    await service.addPart(ORG, WO_ID, { goodId: GOOD_ID, warehouseId: WAREHOUSE_ID, quantity: 1 });

    const data = woUpdate.mock.calls[0][0].data;
    expect(data.totalLabor).toBe(500);
    expect(data.totalActualLabor).toBe(500); // 2*100 + 3*100 = 500 (normoHours fallback)
    expect(data.totalAmount).toBe(500); // totalActualLabor + 0 parts
  });

  it('mixed actualHours/null → uses actualHours when set, normoHours when null', async () => {
    const lines: LineRow[] = [
      { amount: 200, actualHours: 2.5, normoHours: 2, price: 100 }, // actual 2.5*100 = 250
      { amount: 300, actualHours: null, normoHours: 3, price: 100 }, // norm 3*100 = 300
      { amount: 400, actualHours: 5, normoHours: 4, price: 100 }, // actual 5*100 = 500
    ];
    const { prisma, woUpdate } = makePrismaSpy(lines, 150);
    const service = makeService(prisma);
    await service.addPart(ORG, WO_ID, { goodId: GOOD_ID, warehouseId: WAREHOUSE_ID, quantity: 1 });

    const data = woUpdate.mock.calls[0][0].data;
    expect(data.totalLabor).toBe(900); // sum of l.amount (planned)
    expect(data.totalActualLabor).toBe(1050); // 250 + 300 + 500
    expect(data.totalParts).toBe(150);
    expect(data.totalAmount).toBe(1200); // totalActualLabor + totalParts = 1050 + 150
  });

  it('all actualHours set → totalActualLabor uses ONLY actualHours (planned amount ignored)', async () => {
    const lines: LineRow[] = [
      { amount: 200, actualHours: 1, normoHours: 2, price: 100 }, // actual 1*100 = 100
      { amount: 300, actualHours: 4, normoHours: 3, price: 100 }, // actual 4*100 = 400
    ];
    const { prisma, woUpdate } = makePrismaSpy(lines, 50);
    const service = makeService(prisma);
    await service.addPart(ORG, WO_ID, { goodId: GOOD_ID, warehouseId: WAREHOUSE_ID, quantity: 1 });

    const data = woUpdate.mock.calls[0][0].data;
    expect(data.totalLabor).toBe(500); // planned 500
    expect(data.totalActualLabor).toBe(500); // 100 + 400 = 500 (by coincidence same total here)
    expect(data.totalAmount).toBe(550); // 500 + 50
  });

  it('totalAmount formula = totalActualLabor + totalParts (NOT totalLabor + totalParts)', async () => {
    // Forced divergence so the formula is unambiguous in the snapshot.
    const lines: LineRow[] = [
      { amount: 100, actualHours: 5, normoHours: 1, price: 100 }, // planned 100, actual 500
    ];
    const { prisma, woUpdate } = makePrismaSpy(lines, 200);
    const service = makeService(prisma);
    await service.addPart(ORG, WO_ID, { goodId: GOOD_ID, warehouseId: WAREHOUSE_ID, quantity: 1 });

    const data = woUpdate.mock.calls[0][0].data;
    expect(data.totalLabor).toBe(100);
    expect(data.totalActualLabor).toBe(500);
    expect(data.totalParts).toBe(200);
    // REGRESSION GUARD: totalAmount MUST equal totalActualLabor + totalParts.
    // If someone re-introduces `totalAmount: totalLabor + totalParts`, this fails (100+200=300 vs 700).
    expect(data.totalAmount).toBe(700);
    expect(data.totalAmount).not.toBe(data.totalLabor + data.totalParts);
  });

  it('actualHours=0 is treated as actual (not falsy fallback to normoHours)', async () => {
    // Critical: ?? (nullish) vs || (falsy). actualHours=0 means "0 hours worked"
    // (e.g. work was started but cancelled), not "fall back to plan".
    const lines: LineRow[] = [
      { amount: 500, actualHours: 0, normoHours: 5, price: 100 }, // actual 0*100 = 0
    ];
    const { prisma, woUpdate } = makePrismaSpy(lines, 0);
    const service = makeService(prisma);
    await service.addPart(ORG, WO_ID, { goodId: GOOD_ID, warehouseId: WAREHOUSE_ID, quantity: 1 });

    const data = woUpdate.mock.calls[0][0].data;
    expect(data.totalLabor).toBe(500);
    expect(data.totalActualLabor).toBe(0); // actualHours=0 wins over normoHours=5
    expect(data.totalAmount).toBe(0); // 0 actual + 0 parts
  });
});
