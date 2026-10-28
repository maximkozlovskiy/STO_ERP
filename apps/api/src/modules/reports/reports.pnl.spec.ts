import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ReportsService } from './reports.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { matchesWhere } from '../calendar/calendar.spec-fixture';
import type { PnlReportDto, PnlRowKey } from './reports.dto';

/**
 * BR-RPT-030 — звіт P&L (`ReportsService.pnl`).
 *
 * Каса, банк, курсові різниці, зарплата й статті — сховище в пам'яті, яке ВИКОНУЄ Prisma `where`
 * (`matchesWhere`): тест описує, які операції потрапляють у звіт, а не форму запиту. Виручка й
 * запчастини — агрегатний SQL (той самий відбір, що «Рентабельність», BR-RPT-023, покритий там);
 * тут `$queryRaw` віддає готові рядки по місяцях.
 *
 * Mutation-verify (2026-10-29): прибрати відсіювання сторнованих оригіналів → падає «сторнована
 * пара»; прибрати `reason: 'EXPENSE'` з відбору каси → падає «PAYROLL і SUPPLIER_PAYMENT»; прибрати
 * `status: 'MATCHED'` з банку → падає «банк лише MATCHED EXPENSE»; `amount` замість
 * `amountBase ?? amount` → падає «мультивалюта»; знак `+ expenses` у чистому прибутку → падає формула.
 */

type Row = Record<string, unknown>;
const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const at = (iso: string) => new Date(iso);
const day = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);

function store(rows: Row[]) {
  return {
    findMany: vi.fn(({ where }: { where: Row }) =>
      Promise.resolve(rows.filter(r => matchesWhere(r, where))),
    ),
  };
}

interface Data {
  revenue?: { month: string; revenue: number }[];
  parts?: { month: string; costParts: number; unknownCount: bigint }[];
  periods?: Row[];
  cash?: Row[];
  bank?: Row[];
  fx?: Row[];
  categories?: Row[];
}

const CATEGORIES: Row[] = [
  { orgId: ORG, id: 'rent', name: 'Оренда', parentId: null, sortOrder: 0, type: 'EXPENSE' },
  { orgId: ORG, id: 'misc', name: 'Інші доходи', parentId: null, sortOrder: 1, type: 'INCOME' },
  {
    orgId: ORG,
    id: 'sales',
    name: 'Оплати клієнтів',
    parentId: null,
    sortOrder: 2,
    type: 'INCOME',
  },
];
const catRef = (id: string | null) => CATEGORIES.find(c => c.id === id) ?? null;

let seq = 0;
function cash(
  over: Row & { direction: string; reason: string; amount: number; createdAt: Date },
): Row {
  const expenseCategoryId = (over.expenseCategoryId as string | null | undefined) ?? null;
  return {
    id: `cash-${++seq}`,
    orgId: ORG,
    amountBase: null,
    reversalOfId: null,
    ...over,
    expenseCategoryId,
    expenseCategory: catRef(expenseCategoryId),
  };
}
function bank(over: Row & { amount: number; operationDate: Date }): Row {
  return {
    orgId: ORG,
    deletedAt: null,
    direction: 'OUT',
    status: 'MATCHED',
    matchedType: 'EXPENSE',
    amountBase: null,
    expenseCategoryId: 'rent',
    ...over,
  };
}

describe('ReportsService.pnl — BR-RPT-030', () => {
  let service: ReportsService;
  let queryRaw: ReturnType<typeof vi.fn>;
  let data: Data;

  async function run(from: string, to: string, d: Data): Promise<PnlReportDto> {
    data = d;
    queryRaw.mockResolvedValueOnce(d.revenue ?? []).mockResolvedValueOnce(d.parts ?? []);
    return service.pnl(ORG, from, to);
  }
  const line = (r: PnlReportDto, key: PnlRowKey) => r.rows.find(x => x.key === key)?.amounts;
  const total = (r: PnlReportDto, key: PnlRowKey) => r.rows.find(x => x.key === key)?.total;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at('2026-12-15T10:00:00Z'));
    queryRaw = vi.fn();
    data = {};
    const lazy = (k: keyof Data) => ({
      findMany: vi.fn((args: { where: Row }) =>
        store((data[k] as Row[] | undefined) ?? []).findMany(args),
      ),
    });
    const prisma = {
      $queryRaw: queryRaw,
      payrollPeriod: lazy('periods'),
      cashOperation: lazy('cash'),
      bankTransaction: lazy('bank'),
      settlementTransaction: lazy('fx'),
      expenseCategory: { findMany: vi.fn(() => Promise.resolve(data.categories ?? CATEGORIES)) },
    };
    const module = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettingsService, useValue: {} },
      ],
    }).compile();
    service = module.get(ReportsService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // guards: BR-RPT-030
  it('формула: валовий = виручка − запчастини; чистий = валовий − зарплата − витрати + інші доходи + курсові', async () => {
    const r = await run('2026-10-01', '2026-10-31', {
      revenue: [{ month: '2026-10', revenue: 10_000 }],
      parts: [{ month: '2026-10', costParts: 3000, unknownCount: 2n }],
      periods: [
        {
          orgId: ORG,
          periodStart: day('2026-10-01'),
          periodEnd: day('2026-10-31'),
          status: 'PAID',
          deletedAt: null,
          lines: [{ accruedAmount: 1500 }, { accruedAmount: 500 }],
        },
      ],
      cash: [
        cash({
          direction: 'OUT',
          reason: 'EXPENSE',
          amount: 500,
          expenseCategoryId: 'rent',
          createdAt: at('2026-10-10T09:00:00Z'),
        }),
        cash({
          direction: 'IN',
          reason: 'MANUAL_IN',
          amount: 100,
          expenseCategoryId: 'misc',
          createdAt: at('2026-10-11T09:00:00Z'),
        }),
      ],
      bank: [bank({ amount: 300, operationDate: day('2026-10-20') })],
      fx: [
        {
          orgId: ORG,
          type: 'FX_GAIN',
          amount: 50,
          amountBase: 50,
          createdAt: at('2026-10-05T09:00:00Z'),
        },
        {
          orgId: ORG,
          type: 'FX_LOSS',
          amount: 20,
          amountBase: 20,
          createdAt: at('2026-10-06T09:00:00Z'),
        },
      ],
    });

    expect(r.months).toEqual(['2026-10']);
    expect(line(r, 'revenue')).toEqual([10_000]);
    expect(line(r, 'partsCost')).toEqual([3000]);
    expect(line(r, 'grossProfit')).toEqual([7000]);
    expect(line(r, 'payroll')).toEqual([2000]);
    expect(line(r, 'expenses')).toEqual([800]);
    expect(line(r, 'otherIncome')).toEqual([100]);
    expect(line(r, 'fx')).toEqual([30]);
    // 7000 − 2000 − 800 + 100 + 30
    expect(line(r, 'netProfit')).toEqual([4330]);
    expect(total(r, 'netProfit')).toBe(4330);
    expect(r.unknownCostPartsCount).toBe(2);
    expect(r.payrollMissingMonths).toEqual([]);
    expect(r.rows.map(x => x.key)).toEqual([
      'revenue',
      'partsCost',
      'grossProfit',
      'payroll',
      'expenses',
      'expenseCategory',
      'otherIncome',
      'incomeCategory',
      'fx',
      'netProfit',
    ]);
    expect(r.rows.find(x => x.key === 'expenseCategory')).toMatchObject({
      categoryId: 'rent',
      label: 'Оренда',
      amounts: [800],
    });
  });

  // guards: BR-RPT-030
  it('сторнована пара каси не входить — навіть коли сторно пізніше за період', async () => {
    const original = cash({
      direction: 'OUT',
      reason: 'EXPENSE',
      amount: 400,
      expenseCategoryId: 'rent',
      createdAt: at('2026-10-10T09:00:00Z'),
    });
    const kept = cash({
      direction: 'OUT',
      reason: 'EXPENSE',
      amount: 70,
      expenseCategoryId: 'rent',
      createdAt: at('2026-10-12T09:00:00Z'),
    });
    const reversal = cash({
      direction: 'IN',
      reason: 'EXPENSE',
      amount: 400,
      expenseCategoryId: 'rent',
      reversalOfId: original.id,
      createdAt: at('2026-11-03T09:00:00Z'),
    });
    const r = await run('2026-10-01', '2026-10-31', { cash: [original, kept, reversal] });
    expect(line(r, 'expenses')).toEqual([70]);
    expect(line(r, 'netProfit')).toEqual([-70]);
  });

  // guards: BR-RPT-030
  it('PAYROLL і SUPPLIER_PAYMENT зі статтею — не витрати; оплата клієнта й внесок власника — не інший дохід', async () => {
    const r = await run('2026-10-01', '2026-10-31', {
      cash: [
        cash({
          direction: 'OUT',
          reason: 'PAYROLL',
          amount: 900,
          expenseCategoryId: 'rent',
          createdAt: at('2026-10-10T09:00:00Z'),
        }),
        cash({
          direction: 'OUT',
          reason: 'SUPPLIER_PAYMENT',
          amount: 800,
          expenseCategoryId: 'rent',
          createdAt: at('2026-10-10T09:00:00Z'),
        }),
        cash({
          direction: 'OUT',
          reason: 'OWNER_OUT',
          amount: 700,
          createdAt: at('2026-10-10T09:00:00Z'),
        }),
        cash({
          direction: 'IN',
          reason: 'SALE_PAYMENT',
          amount: 600,
          expenseCategoryId: 'sales',
          createdAt: at('2026-10-10T09:00:00Z'),
        }),
        cash({
          direction: 'IN',
          reason: 'OWNER_IN',
          amount: 500,
          expenseCategoryId: 'misc',
          createdAt: at('2026-10-10T09:00:00Z'),
        }),
        // Ручне внесення без статті доходу — не дохід (рядок статті немає звідки взяти).
        cash({
          direction: 'IN',
          reason: 'MANUAL_IN',
          amount: 400,
          createdAt: at('2026-10-10T09:00:00Z'),
        }),
        cash({
          direction: 'OUT',
          reason: 'EXPENSE',
          amount: 33,
          createdAt: at('2026-10-10T09:00:00Z'),
        }),
      ],
    });
    expect(line(r, 'expenses')).toEqual([33]);
    expect(line(r, 'otherIncome')).toEqual([0]);
    // Витрата без статті — окремий рядок «без статті».
    expect(r.rows.find(x => x.key === 'expenseCategory')).toMatchObject({
      categoryId: null,
      amounts: [33],
    });
    expect(r.rows.some(x => x.key === 'incomeCategory')).toBe(false);
  });

  // guards: BR-RPT-030
  it('банк — лише MATCHED EXPENSE OUT, не видалені; місяць — за датою операції', async () => {
    const r = await run('2026-10-01', '2026-11-30', {
      bank: [
        bank({ amount: 100, operationDate: day('2026-10-31') }),
        bank({ amount: 200, operationDate: day('2026-11-01') }),
        bank({ amount: 1, operationDate: day('2026-12-01') }),
        bank({ amount: 2, operationDate: day('2026-10-15'), status: 'UNMATCHED' }),
        bank({ amount: 4, operationDate: day('2026-10-15'), matchedType: 'PAYROLL' }),
        bank({ amount: 8, operationDate: day('2026-10-15'), matchedType: 'SUPPLIER_PAYMENT' }),
        bank({
          amount: 16,
          operationDate: day('2026-10-15'),
          deletedAt: at('2026-10-16T00:00:00Z'),
        }),
        bank({ amount: 32, operationDate: day('2026-10-15'), direction: 'IN' }),
        bank({ amount: 64, operationDate: day('2026-10-15'), orgId: OTHER_ORG }),
      ],
    });
    expect(r.months).toEqual(['2026-10', '2026-11']);
    expect(line(r, 'expenses')).toEqual([100, 200]);
  });

  // guards: BR-RPT-030
  it('мультивалюта: сума в базовій валюті (amountBase), без неї — amount', async () => {
    const r = await run('2026-10-01', '2026-10-31', {
      cash: [
        cash({
          direction: 'OUT',
          reason: 'EXPENSE',
          amount: 10,
          amountBase: 415.5,
          expenseCategoryId: 'rent',
          createdAt: at('2026-10-10T09:00:00Z'),
        }),
        cash({
          direction: 'OUT',
          reason: 'EXPENSE',
          amount: 20,
          expenseCategoryId: 'rent',
          createdAt: at('2026-10-10T09:00:00Z'),
        }),
      ],
      bank: [bank({ amount: 100, amountBase: 4100, operationDate: day('2026-10-02') })],
      fx: [
        {
          orgId: ORG,
          type: 'FX_LOSS',
          amount: 3,
          amountBase: 3,
          createdAt: at('2026-10-05T09:00:00Z'),
        },
      ],
    });
    expect(line(r, 'expenses')).toEqual([4535.5]);
    expect(line(r, 'fx')).toEqual([-3]);
  });

  // guards: BR-RPT-030
  it('місяць каси — київський: 31.10 22:30 UTC — це вже 01.11 за Києвом', async () => {
    const r = await run('2026-10-01', '2026-11-30', {
      cash: [
        cash({
          direction: 'OUT',
          reason: 'EXPENSE',
          amount: 5,
          expenseCategoryId: 'rent',
          createdAt: at('2026-10-31T22:30:00Z'),
        }),
      ],
    });
    expect(line(r, 'expenses')).toEqual([0, 5]);
  });

  // guards: BR-RPT-030
  it('місяць без розрахованої зарплати — у payrollMissingMonths', async () => {
    const r = await run('2026-09-01', '2026-10-31', {
      periods: [
        {
          orgId: ORG,
          periodStart: day('2026-09-01'),
          periodEnd: day('2026-09-30'),
          status: 'COMPUTED',
          deletedAt: null,
          lines: [{ accruedAmount: 1000 }],
        },
        {
          orgId: ORG,
          periodStart: day('2026-10-01'),
          periodEnd: day('2026-10-31'),
          status: 'DRAFT',
          deletedAt: null,
          lines: [{ accruedAmount: 999 }],
        },
        {
          orgId: OTHER_ORG,
          periodStart: day('2026-10-01'),
          periodEnd: day('2026-10-31'),
          status: 'PAID',
          deletedAt: null,
          lines: [{ accruedAmount: 777 }],
        },
      ],
    });
    expect(line(r, 'payroll')).toEqual([1000, 0]);
    expect(r.payrollMissingMonths).toEqual(['2026-10']);
  });

  // guards: BR-RPT-030
  it('період довший за 24 місяці → 400; рівно 24 — можна', async () => {
    await expect(service.pnl(ORG, '2024-01-01', '2026-01-31')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const r = await run('2024-01-01', '2025-12-31', {});
    expect(r.months).toHaveLength(24);
  });

  it('початок пізніше кінця → 400', async () => {
    await expect(service.pnl(ORG, '2026-10-02', '2026-10-01')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('гроші квантовані до копійки (0.1 + 0.2)', async () => {
    const r = await run('2026-10-01', '2026-10-31', {
      cash: [
        cash({
          direction: 'OUT',
          reason: 'EXPENSE',
          amount: 0.1,
          expenseCategoryId: 'rent',
          createdAt: at('2026-10-10T09:00:00Z'),
        }),
        cash({
          direction: 'OUT',
          reason: 'EXPENSE',
          amount: 0.2,
          expenseCategoryId: 'rent',
          createdAt: at('2026-10-10T09:00:00Z'),
        }),
      ],
    });
    expect(line(r, 'expenses')).toEqual([0.3]);
    expect(line(r, 'netProfit')).toEqual([-0.3]);
  });
});
