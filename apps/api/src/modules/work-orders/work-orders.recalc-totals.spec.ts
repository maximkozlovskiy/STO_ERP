import { describe, it, expect, vi } from 'vitest';
import { WorkOrdersService } from './work-orders.service';
import { WorkOrderTotalsService } from './work-order-totals.service';
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
    // Мультивалюта (Фаза 3): recalcTotals читає currencyId/documentDate наряду. null → base.
    workOrder: {
      update: woUpdate,
      findFirst: vi.fn().mockResolvedValue({ currencyId: null, documentDate: new Date() }),
    },
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
  const exchangeRates = {
    resolveBaseConversion: vi
      .fn()
      .mockImplementation(async (_o: string, _c: string, _d: Date, amount: number) => ({
        rateUsed: 1,
        amountBase: amount,
      })),
    getBaseCurrency: vi.fn().mockResolvedValue({ id: null, code: 'UAH' }),
    requireBaseCurrencyId: vi.fn().mockResolvedValue('base-cur-id'),
  } as never;
  return new WorkOrdersService(
    prisma,
    null as never, // stockEffects (A3 — не задіяний у recalc-шляху)
    null as never, // docNumbers
    null as never, // pdf
    null as never, // audit
    settingsService, // settingsService (Bug #536)
    // exchangeRates (Фаза 3): default base — recalcTotals пише totalAmountBase (base=amount, rate=1)
    exchangeRates,
    null as never, // events (EventEmitter2)
    new WorkOrderTotalsService(settingsService, exchangeRates),
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

  // guards: BR-WO-005
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

  // guards: BR-WO-005
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

  // Мультивалюта (Фаза 3): recalcTotals пише totalAmountBase/rateUsed. Base-валюта (мок default)
  // → base = totalAmount, rate = 1 (не залишаються undefined — інакше base-звітність порожня).
  it('пише totalAmountBase + rateUsed (base-валюта → base=totalAmount, rate=1)', async () => {
    const lines: LineRow[] = [{ amount: 300, actualHours: 3, normoHours: 3, price: 100 }];
    const { prisma, woUpdate } = makePrismaSpy(lines, 200);
    const service = makeService(prisma);
    await service.addPart(ORG, WO_ID, { goodId: GOOD_ID, warehouseId: WAREHOUSE_ID, quantity: 1 });

    const data = woUpdate.mock.calls[0][0].data;
    expect(data.totalAmount).toBe(500); // 300 actual + 200 parts
    expect(data.totalAmountBase).toBe(500);
    expect(data.rateUsed).toBe(1);
  });
});

// ─── BR-WO-007: склад суми наряду за режимом ПДВ ─────────────────────────────
//
// `totalAmount` — сума ДО СПЛАТИ (з ПДВ у всіх режимах), `totalNet` — без ПДВ,
// інваріант `totalNet + totalVat = totalAmount`. Тут — сам власник тоталів
// `WorkOrderTotalsService.recalc(workOrderId, tx, orgId)` на tx-моку: що саме лягає у
// `tx.workOrder.update` для кожного режиму організації.

type VatSettings = { vatMode: 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE'; vatRate: number };

function makeTotals(opts: {
  vat: VatSettings;
  lines: LineRow[];
  partsSum: number;
  currencyId?: string | null;
  documentDate?: Date;
  rate?: number;
}) {
  const woUpdate = vi.fn().mockResolvedValue({});
  const tx = {
    workOrder: {
      update: woUpdate,
      findFirst: vi.fn().mockResolvedValue({
        currencyId: opts.currencyId ?? null,
        documentDate: opts.documentDate ?? new Date('2026-10-01'),
      }),
    },
    workOrderLine: { findMany: vi.fn().mockResolvedValue(opts.lines) },
    workOrderPart: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { amount: opts.partsSum } }),
    },
  };
  const settings = { getDefaultVatRate: vi.fn().mockResolvedValue(opts.vat) };
  const rate = opts.rate ?? 1;
  const resolveBaseConversion = vi
    .fn()
    .mockImplementation((_o: string, _c: string, _d: Date, amount: number) =>
      Promise.resolve({ rateUsed: rate, amountBase: amount * rate }),
    );
  const service = new WorkOrderTotalsService(settings as never, { resolveBaseConversion } as never);
  const run = async () => {
    await service.recalc(WO_ID, tx as never, ORG);
    return woUpdate.mock.calls[0][0] as { where: unknown; data: Record<string, number> };
  };
  return { run, tx, woUpdate, settings, resolveBaseConversion };
}

describe('WorkOrderTotalsService.recalc — склад суми за режимом ПДВ (BR-WO-007)', () => {
  // 3 год × 100 = 300 робіт + 200 запчастин → сума рядків 500.
  const LINES: LineRow[] = [{ amount: 300, actualHours: 3, normoHours: 3, price: 100 }];

  // guards: BR-WO-007
  it('без ПДВ: totalNet = totalAmount = сума рядків, totalVat = 0', async () => {
    const { run, settings } = makeTotals({
      vat: { vatMode: 'NONE', vatRate: 0 },
      lines: LINES,
      partsSum: 200,
    });

    const { data } = await run();

    expect(settings.getDefaultVatRate).toHaveBeenCalledWith(ORG);
    expect(data.totalNet).toBe(500);
    expect(data.totalVat).toBe(0);
    expect(data.totalAmount).toBe(500);
  });

  // guards: BR-WO-007
  it('ПДВ у ціні 20%: totalAmount = сума рядків, totalNet = сума рядків − ПДВ', async () => {
    // Рядки на 600 з ПДВ у ціні → ПДВ 100, без ПДВ 500.
    const { run } = makeTotals({
      vat: { vatMode: 'INCLUSIVE', vatRate: 20 },
      lines: [{ amount: 400, actualHours: 4, normoHours: 4, price: 100 }],
      partsSum: 200,
    });

    const { data } = await run();

    expect(data.totalAmount).toBe(600);
    expect(data.totalVat).toBe(100);
    expect(data.totalNet).toBe(500);
    expect(data.totalNet + data.totalVat).toBe(data.totalAmount);
  });

  // guards: BR-WO-007
  it('ПДВ зверху 20%: totalNet = сума рядків, totalAmount = сума рядків + ПДВ (до сплати)', async () => {
    const { run } = makeTotals({
      vat: { vatMode: 'EXCLUSIVE', vatRate: 20 },
      lines: LINES,
      partsSum: 200,
    });

    const { data } = await run();

    expect(data.totalNet).toBe(500);
    expect(data.totalVat).toBe(100);
    // До BR-WO-007 сюди лягало 500 — борг клієнта при COMPLETED виходив без ПДВ.
    expect(data.totalAmount).toBe(600);
    expect(data.totalNet + data.totalVat).toBe(data.totalAmount);
    // Складові рядків від режиму не залежать.
    expect(data.totalActualLabor).toBe(300);
    expect(data.totalParts).toBe(200);
  });

  // guards: BR-WO-007
  it('ПДВ зверху: копійки — ПДВ від суми рядків, усі три суми квантовано (99.99 → 20.00 → 119.99)', async () => {
    const { run } = makeTotals({
      vat: { vatMode: 'EXCLUSIVE', vatRate: 20 },
      lines: [{ amount: 66.66, actualHours: null, normoHours: 2, price: 33.33 }],
      partsSum: 33.33,
    });

    const { data } = await run();

    expect(data.totalNet).toBe(99.99);
    expect(data.totalVat).toBe(20);
    expect(data.totalAmount).toBe(119.99);
  });

  // guards: BR-WO-007
  it('totalAmountBase рахується від суми ДО СПЛАТИ (з ПДВ), а не від суми рядків', async () => {
    const documentDate = new Date('2026-09-15');
    const { run, resolveBaseConversion } = makeTotals({
      vat: { vatMode: 'EXCLUSIVE', vatRate: 20 },
      lines: LINES,
      partsSum: 200,
      currencyId: 'cur-usd',
      documentDate,
      rate: 40,
    });

    const { data } = await run();

    expect(resolveBaseConversion).toHaveBeenCalledTimes(1);
    expect(resolveBaseConversion).toHaveBeenCalledWith(ORG, 'cur-usd', documentDate, 600, true);
    expect(data.totalAmountBase).toBe(24_000); // 600 × 40, не 500 × 40
    expect(data.rateUsed).toBe(40);
  });

  // guards: BR-WO-007
  it('базова валюта (без currencyId), ПДВ зверху: totalAmountBase = totalAmount з ПДВ, rate = 1', async () => {
    const { run, resolveBaseConversion } = makeTotals({
      vat: { vatMode: 'EXCLUSIVE', vatRate: 20 },
      lines: LINES,
      partsSum: 200,
    });

    const { data } = await run();

    expect(resolveBaseConversion).not.toHaveBeenCalled();
    expect(data.totalAmountBase).toBe(600);
    expect(data.rateUsed).toBe(1);
  });

  // guards: BR-WO-007
  it('пише тотали одним update у переданій транзакції, у межах свого orgId', async () => {
    const { run, tx, woUpdate } = makeTotals({
      vat: { vatMode: 'INCLUSIVE', vatRate: 20 },
      lines: LINES,
      partsSum: 200,
    });

    const { where } = await run();

    expect(woUpdate).toHaveBeenCalledTimes(1);
    expect(where).toEqual({ id: WO_ID, orgId: ORG });
    expect(tx.workOrderLine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workOrderId: WO_ID, orgId: ORG, deletedAt: null },
      }),
    );
    expect(tx.workOrderPart.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workOrderId: WO_ID, orgId: ORG, deletedAt: null },
      }),
    );
  });
});

// ─── BR-WO-007: клон наряду — тотали рахує recalc, а не копія з оригіналу ─────

describe('WorkOrdersService.clone — тотали клона через recalc у транзакції (BR-WO-007)', () => {
  const VEHICLE = '55555555-5555-4555-8555-555555555555';
  const CP = '66666666-6666-4666-8666-666666666666';
  const BRANCH = '77777777-7777-4777-8777-777777777777';
  const CLONE_ID = '88888888-8888-4888-8888-888888888888';

  /** Рядок, який повертає перечитування клона — рівно стільки, скільки читає toDto. */
  const clonedRow = (totalAmount: number) => ({
    id: CLONE_ID,
    orgId: ORG,
    number: 'НЗ-2026-000042',
    status: 'DRAFT',
    priority: 'NORMAL',
    repairCategory: null,
    branchId: BRANCH,
    branch: { name: 'Br' },
    vehicleId: VEHICLE,
    vehicle: { make: 'X', model: 'Y', licensePlate: 'AB1234' },
    counterpartyId: CP,
    counterparty: { firstName: 'Іван', lastName: 'Петров', companyName: null },
    contractId: null,
    contract: null,
    description: null,
    inMileage: null,
    outMileage: null,
    plannedAt: null,
    dueDate: null,
    completedAt: null,
    warrantyUntil: null,
    clientApproval: false,
    totalLabor: 200,
    totalParts: 500,
    totalNet: 700,
    totalVat: 140,
    totalAmount,
    paidAmount: 0,
    documentDate: new Date('2026-10-08'),
    syncVersion: 0n,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  });

  function setupClone() {
    const order: string[] = [];
    // Оригінал завершено за старих налаштувань: його тотали (999) клонові не годяться.
    const original = {
      number: 'НЗ-2026-000001',
      vehicleId: VEHICLE,
      counterpartyId: CP,
      branchId: BRANCH,
      liftId: null,
      description: null,
      inMileage: null,
      priority: 'NORMAL',
      repairCategory: null,
      dueDate: null,
      plannedHours: null,
      currencyId: null,
      totalLabor: 999,
      totalActualLabor: 999,
      totalParts: 999,
      totalNet: 999,
      totalVat: 999,
      totalAmount: 999,
      totalAmountBase: 999,
      rateUsed: 9,
      lines: [
        {
          workId: 'w-1',
          employeeId: null,
          liftId: null,
          price: 100,
          normoHours: 2,
          actualHours: 5,
          notes: null,
          amount: 200,
        },
      ],
      parts: [{ goodId: 'g-1', quantity: 1, price: 500, warehouseId: 'wh-1', amount: 500 }],
    };
    const tx = {
      workOrder: {
        create: vi.fn().mockImplementation(() => {
          order.push('create');
          return Promise.resolve({ id: CLONE_ID });
        }),
        findFirstOrThrow: vi.fn().mockImplementation(() => {
          order.push('reread');
          return Promise.resolve(clonedRow(840));
        }),
      },
    };
    const outerCreate = vi.fn();
    const prisma = {
      workOrder: { findFirst: vi.fn().mockResolvedValue(original), create: outerCreate },
      vehicle: { findFirst: vi.fn().mockResolvedValue({ id: VEHICLE }) },
      counterparty: { findFirst: vi.fn().mockResolvedValue({ id: CP }) },
      garageBranch: { findFirst: vi.fn().mockResolvedValue({ id: BRANCH }) },
      $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => {
        order.push('tx-begin');
        const res = await cb(tx);
        order.push('tx-end');
        return res;
      }),
    } as unknown as PrismaService;
    const recalc = vi.fn().mockImplementation(() => {
      order.push('recalc');
      return Promise.resolve();
    });
    const service = new WorkOrdersService(
      prisma,
      null as never, // stockEffects
      { next: vi.fn().mockResolvedValue('НЗ-2026-000042') } as never, // docNumbers
      null as never, // pdf
      null as never, // audit (userId не передаємо → не викликається)
      null as never, // settingsService
      { resolveBaseConversion: vi.fn(), requireBaseCurrencyId: vi.fn() } as never,
      { emit: vi.fn() } as never, // events
      { recalc } as never, // totals — єдиний власник суми наряду
    );
    return { service, tx, recalc, order, outerCreate };
  }

  // guards: BR-WO-007
  it('create клона не несе жодного поля total* / rateUsed — тотали оригіналу не копіюються', async () => {
    const { service, tx } = setupClone();

    await service.clone(ORG, 'wo-orig', undefined as never);

    const data = tx.workOrder.create.mock.calls[0][0].data as Record<string, unknown>;
    const totalKeys = Object.keys(data).filter(k => k.startsWith('total') || k === 'rateUsed');
    expect(totalKeys).toEqual([]);
    // Рядки при цьому скопійовано — саме з них recalc порахує суму.
    expect((data.lines as { create: unknown[] }).create).toHaveLength(1);
    expect((data.parts as { create: unknown[] }).create).toHaveLength(1);
  });

  // guards: BR-WO-007
  it('recalc кличеться рівно раз — для КЛОНА, у тій самій транзакції, після create і до перечитування', async () => {
    const { service, tx, recalc, order, outerCreate } = setupClone();

    await service.clone(ORG, 'wo-orig', undefined as never);

    expect(recalc).toHaveBeenCalledTimes(1);
    expect(recalc).toHaveBeenCalledWith(CLONE_ID, tx, ORG);
    expect(order).toEqual(['tx-begin', 'create', 'recalc', 'reread', 'tx-end']);
    // Клон створюється лише через tx: create поза транзакцією лишив би наряд без тоталів.
    expect(outerCreate).not.toHaveBeenCalled();
  });

  // guards: BR-WO-007
  it('відповідь несе тотали, перечитані ПІСЛЯ recalc (840), а не суму оригіналу (999)', async () => {
    const { service, tx } = setupClone();

    const dto = await service.clone(ORG, 'wo-orig', undefined as never);

    expect(tx.workOrder.findFirstOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CLONE_ID, orgId: ORG } }),
    );
    expect(dto.totalAmount).toBe(840);
  });

  // guards: BR-WO-007
  it('recalc упав → помилка виходить із транзакції (клон без тоталів не лишається)', async () => {
    const { service, recalc, order } = setupClone();
    recalc.mockImplementation(() => {
      order.push('recalc');
      return Promise.reject(new Error('recalc failed'));
    });

    await expect(service.clone(ORG, 'wo-orig', undefined as never)).rejects.toThrow(
      'recalc failed',
    );
    // Колбек транзакції не дійшов до кінця → Prisma відкочує create.
    expect(order).toEqual(['tx-begin', 'create', 'recalc']);
  });
});

describe('WorkOrderTotalsService.recalc — сума наряду = сума округлених рядків (BR-WO-007)', () => {
  // Три роботи по 0,3 год × 111,11 = 33,333 кожна. Рядок у документі — 33,33, три рядки — 99,99.
  // Раніше сирі добутки сумувались (99,999) і округлювались раз → 100,00: рядки акта давали
  // 100,06 при підсумку 100,07.
  const KOPECK_LINES: LineRow[] = [
    { amount: 33.33, actualHours: 0.3, normoHours: 0.3, price: 111.11 },
    { amount: 33.33, actualHours: 0.3, normoHours: 0.3, price: 111.11 },
    { amount: 33.33, actualHours: 0.3, normoHours: 0.3, price: 111.11 },
  ];

  // guards: BR-WO-007
  it('без ПДВ: 3 × (0,3 × 111,11) + запчастина 0,07 → 99,99 + 0,07 = 100,06, а не 100,07', async () => {
    const { run } = makeTotals({
      vat: { vatMode: 'NONE', vatRate: 0 },
      lines: KOPECK_LINES,
      partsSum: 0.07,
    });

    const { data } = await run();

    expect(data.totalActualLabor).toBe(99.99);
    expect(data.totalNet).toBe(100.06);
    expect(data.totalAmount).toBe(100.06);
  });

  // guards: BR-WO-007
  it('ПДВ зверху: ПДВ один раз від суми округлених рядків (100,06 → 20,01 → 120,07)', async () => {
    const { run } = makeTotals({
      vat: { vatMode: 'EXCLUSIVE', vatRate: 20 },
      lines: KOPECK_LINES,
      partsSum: 0.07,
    });

    const { data } = await run();

    expect(data.totalNet).toBe(100.06);
    expect(data.totalVat).toBe(20.01);
    expect(data.totalAmount).toBe(120.07);
  });

  // guards: BR-WO-007
  it('рядок, що округлюється вгору (0,7 × 199,99 = 139,993 → 139,99; 1,5 × 333,33 = 499,995 → 500,00)', async () => {
    const { run } = makeTotals({
      vat: { vatMode: 'NONE', vatRate: 0 },
      lines: [
        { amount: 500, actualHours: 1.5, normoHours: 1.5, price: 333.33 },
        { amount: 139.99, actualHours: 0.7, normoHours: 0.7, price: 199.99 },
      ],
      partsSum: 0,
    });

    const { data } = await run();

    expect(data.totalActualLabor).toBe(639.99);
  });
});
