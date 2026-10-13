/**
 * Спільний harness для аспектних спеків CashService (tenant, запис операції).
 *
 * `makeMocks` / `makeService` СКОПІЙОВАНО з `cash.service.spec.ts` (той файл лишає власну
 * копію — його не чіпали, щоб не рухати наявні кейси). FACTORY, не `const`:
 * `vitest.config.ts` має `isolate: false` без `clearMocks`, тож module-level `vi.fn()` жив би
 * спільно для всіх спеків воркера.
 *
 * DI-DRIFT GUARD: нова залежність у конструкторі CashService правиться тут.
 */
import { vi } from 'vitest';
import { CashService } from './cash.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';

export const ORG = '11111111-1111-4111-8111-111111111111';
export const REG = '22222222-2222-4222-8222-222222222222';
export const USER = '44444444-4444-4444-8444-444444444444';

/** Рядок CashOperation, який «повертає БД» після create. */
export function opRow(over: Record<string, unknown> = {}) {
  return {
    id: 'op-1',
    cashRegisterId: REG,
    cashShiftId: null,
    direction: 'IN',
    amount: 500,
    reason: 'MANUAL_IN',
    expenseCategoryId: null,
    counterpartyId: null,
    employeeId: null,
    documentType: null,
    documentId: null,
    notes: null,
    createdAt: new Date('2026-10-08T09:00:00.000Z'),
    expenseCategory: null,
    ...over,
  };
}

// ── Таблиця в пам'яті для спеків, написаних ДО коду ──────────────────────────────────────────
//
// Спеки «каси як місця оплат» (BR-CASH-016…022) пишуться з правил, коли сервісу ще немає: скільки
// запитів він зробить і в якому порядку — невідомо, тож ланцюжок `mockResolvedValueOnce` тут
// непридатний. Натомість делегат Prisma відповідає з рядків у пам'яті, застосовуючи `where`
// по-справжньому: чужа організація, видалений рядок чи вимкнена стаття не знаходяться тому, що
// так написано в запиті сервісу, а не тому, що так сказав мок.

export type MemRow = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !(v instanceof Date) && !Array.isArray(v);

function fieldMatches(actual: unknown, cond: unknown): boolean {
  if (!isPlainObject(cond)) return (actual ?? null) === (cond ?? null);
  return Object.entries(cond).every(([op, expected]) => {
    if (op === 'equals') return (actual ?? null) === (expected ?? null);
    if (op === 'not') return !fieldMatches(actual, expected);
    if (op === 'in') return (expected as unknown[]).includes(actual);
    if (op === 'notIn') return !(expected as unknown[]).includes(actual);
    throw new Error(
      `Таблиця в пам'яті: оператор «${op}» у where не підтримано — допиши його в cash.spec-fixture.ts`,
    );
  });
}

/** Чи підходить рядок під Prisma-подібний `where` (рівність, null, in/not, AND/OR/NOT). */
export function whereMatches(row: MemRow, where: unknown): boolean {
  if (!isPlainObject(where)) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    const list = (Array.isArray(cond) ? cond : [cond]) as unknown[];
    if (key === 'AND') return list.every(w => whereMatches(row, w));
    if (key === 'OR') return list.some(w => whereMatches(row, w));
    if (key === 'NOT') return !list.some(w => whereMatches(row, w));
    return fieldMatches(row[key], cond);
  });
}

/**
 * Делегат Prisma поверх масиву рядків: читання фільтрують за `where`, запис змінює самі рядки.
 * `select` / `include` ігноруються — віддається рядок цілком (надмножина того, що просив сервіс).
 */
export function memoryTable(rows: MemRow[], defaults: () => MemRow = () => ({})) {
  let seq = 0;
  const find = (args?: { where?: unknown }) => rows.filter(r => whereMatches(r, args?.where));
  const notFound = () => Object.assign(new Error('No record found'), { code: 'P2025' });
  return {
    rows,
    findFirst: vi.fn((args?: { where?: unknown }) => Promise.resolve(find(args)[0] ?? null)),
    findUnique: vi.fn((args?: { where?: unknown }) => Promise.resolve(find(args)[0] ?? null)),
    findFirstOrThrow: vi.fn((args?: { where?: unknown }) => {
      const hit = find(args)[0];
      return hit ? Promise.resolve(hit) : Promise.reject(notFound());
    }),
    findMany: vi.fn((args?: { where?: unknown }) => Promise.resolve(find(args))),
    count: vi.fn((args?: { where?: unknown }) => Promise.resolve(find(args).length)),
    create: vi.fn((args: { data: MemRow }) => {
      seq += 1;
      const row = { id: `mem-${seq}`, ...defaults(), ...args.data };
      rows.push(row);
      return Promise.resolve(row);
    }),
    update: vi.fn((args: { where?: unknown; data: MemRow }) => {
      const hit = find(args)[0];
      if (!hit) return Promise.reject(notFound());
      Object.assign(hit, args.data);
      return Promise.resolve(hit);
    }),
    updateMany: vi.fn((args: { where?: unknown; data: MemRow }) => {
      const hits = find(args);
      for (const hit of hits) Object.assign(hit, args.data);
      return Promise.resolve({ count: hits.length });
    }),
  };
}

export type MemoryTable = ReturnType<typeof memoryTable>;

export function makeMocks() {
  return {
    prisma: {
      cashRegister: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        findFirstOrThrow: vi.fn(),
      },
      cashShift: { findFirst: vi.fn() },
      cashOperation: { create: vi.fn(), findMany: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn() },
      expenseCategory: { findFirst: vi.fn() },
      // Історія каси шукає ще й за назвою контрагента / працівника (план 2026-10-14, п. 3.7):
      // за замовчуванням збігів немає.
      counterparty: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      employee: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      garageBranch: { findFirst: vi.fn() },
      currency: { findFirst: vi.fn() },
      $transaction: vi.fn(),
    },
    audit: { record: vi.fn().mockResolvedValue(undefined) },
    // Мультивалюта: за замовч. базова каса (UAH) → base=amount, rate=1.
    exchangeRates: {
      resolveBaseConversion: vi
        .fn()
        .mockImplementation((_o: string, _c: string, _d: Date, amount: number) =>
          Promise.resolve({ rateUsed: 1, amountBase: amount }),
        ),
    },
  };
}

export type CashMocks = ReturnType<typeof makeMocks>;

export function makeService(m: CashMocks): CashService {
  const s = new CashService(
    m.prisma as unknown as PrismaService,
    m.audit as unknown as AuditService,
    m.exchangeRates as unknown as ExchangeRatesService,
  );
  // $transaction прокидає callback з тим самим prisma-моком (client = prisma).
  m.prisma.$transaction.mockImplementation((fn: (c: unknown) => Promise<unknown>) => fn(m.prisma));
  return s;
}

/**
 * Готовий до операції стан: нефіскальна (за замовч.) каса з залишком `balance`, нульові
 * агрегати, create повертає `opRow()`. Каса віддається на КОЖЕН виклик findFirst
 * (guard каси + getBalance для OUT).
 */
export function setup(opts: { isFiscal?: boolean; balance?: number } = {}) {
  const m = makeMocks();
  const service = makeService(m);
  m.prisma.cashRegister.findFirst.mockResolvedValue({
    id: REG,
    isFiscal: opts.isFiscal ?? false,
    branchId: 'b1',
    currencyId: 'uah-id',
    initialBalance: opts.balance ?? 100000,
  });
  m.prisma.cashOperation.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
  m.prisma.cashOperation.create.mockResolvedValue(opRow());
  return { m, service };
}
