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

/**
 * Зв'язки рядка для фільтрів через relation (`where: { account: { orgId } }`): ім'я поля → функція,
 * що повертає пов'язаний рядок (або null). Без опису зв'язку такий фільтр кидає помилку —
 * тест падає з підказкою, а не мовчки «знаходить» усе.
 */
export type MemRelations = Record<string, (row: MemRow) => MemRow | MemRow[] | null | undefined>;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !(v instanceof Date) && !Array.isArray(v);

/** Число з number / Decimal / рядка; для порівнянь gt/gte/lt/lte і рівності грошей. */
const num = (v: unknown): number =>
  typeof v === 'object' && v !== null && 'toNumber' in v
    ? (v as { toNumber(): number }).toNumber()
    : Number(v);

const isNumeric = (v: unknown): boolean =>
  typeof v === 'number' ||
  (typeof v === 'object' && v !== null && 'toNumber' in v && !(v instanceof Date));

/** Рівність: дати — за часом, числа й Decimal — за значенням, решта — строго. */
function same(actual: unknown, expected: unknown): boolean {
  const a = actual ?? null;
  const e = expected ?? null;
  if (a instanceof Date && e instanceof Date) return a.getTime() === e.getTime();
  if (isNumeric(a) && isNumeric(e)) return num(a) === num(e);
  return a === e;
}

function fieldMatches(actual: unknown, cond: unknown): boolean {
  if (!isPlainObject(cond)) return same(actual, cond);
  return Object.entries(cond).every(([op, expected]) => {
    if (expected === undefined) return true;
    if (op === 'equals') return same(actual, expected);
    if (op === 'not') return !fieldMatches(actual, expected);
    if (op === 'in') return (expected as unknown[]).some(e => same(actual, e));
    if (op === 'notIn') return !(expected as unknown[]).some(e => same(actual, e));
    if (op === 'gt') return actual != null && num(actual) > num(expected);
    if (op === 'gte') return actual != null && num(actual) >= num(expected);
    if (op === 'lt') return actual != null && num(actual) < num(expected);
    if (op === 'lte') return actual != null && num(actual) <= num(expected);
    // `mode: 'insensitive'` — порівняння `contains` тут і так без урахування регістру.
    if (op === 'mode') return true;
    if (op === 'contains')
      return (
        actual != null && String(actual).toLowerCase().includes(String(expected).toLowerCase())
      );
    throw new Error(
      `Таблиця в пам'яті: оператор «${op}» у where не підтримано — допиши його в cash.spec-fixture.ts`,
    );
  });
}

/** Чи підходить рядок під Prisma-подібний `where` (рівність, null, in/not, AND/OR/NOT). */
export function whereMatches(row: MemRow, where: unknown, relations: MemRelations = {}): boolean {
  if (!isPlainObject(where)) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    const list = (Array.isArray(cond) ? cond : [cond]) as unknown[];
    if (key === 'AND') return list.every(w => whereMatches(row, w, relations));
    if (key === 'OR') return list.some(w => whereMatches(row, w, relations));
    if (key === 'NOT') return !list.some(w => whereMatches(row, w, relations));
    // Складений унікальний ключ Prisma (`orgId_goodId_warehouseId: { orgId, goodId, … }`):
    // такого поля в рядку немає — умова на кожне з полів.
    if (!(key in row) && !relations[key] && key.includes('_') && isPlainObject(cond)) {
      return whereMatches(row, cond, relations);
    }
    const relation = relations[key];
    if (relation) {
      const linked = relation(row);
      if (cond === null) return linked == null;
      if (!linked) return false;
      // Зв'язок 1:M: Prisma `some` / `none` / `every`.
      if (Array.isArray(linked)) {
        if (!isPlainObject(cond)) return false;
        if ('some' in cond) return linked.some(l => whereMatches(l, cond.some, relations));
        if ('none' in cond) return !linked.some(l => whereMatches(l, cond.none, relations));
        if ('every' in cond) return linked.every(l => whereMatches(l, cond.every, relations));
        throw new Error("Таблиця в пам'яті: для зв'язку 1:M підтримано лише some/none/every");
      }
      // Prisma: `is` / `isNot` для 1:1, інакше — умова одразу на полях пов'язаного рядка.
      if (isPlainObject(cond) && 'is' in cond) return whereMatches(linked, cond.is, relations);
      if (isPlainObject(cond) && 'isNot' in cond)
        return !whereMatches(linked, cond.isNot, relations);
      return whereMatches(linked, cond, relations);
    }
    return fieldMatches(row[key], cond);
  });
}

/** Округлення до копійки, щоб `increment`/`decrement` не лишали float-пил (0.1 + 0.2). */
const cents = (v: number): number => Math.round(v * 100) / 100;

/** Запис `data` у рядок: прості значення — як є; `{ increment | decrement | set }` — як у Prisma. */
function applyData(row: MemRow, data: MemRow): void {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && 'increment' in value) {
      row[key] = cents(num(row[key] ?? 0) + num(value.increment));
    } else if (isPlainObject(value) && 'decrement' in value) {
      row[key] = cents(num(row[key] ?? 0) - num(value.decrement));
    } else if (isPlainObject(value) && 'set' in value) {
      row[key] = value.set;
    } else {
      row[key] = value;
    }
  }
}

type SortDir = 'asc' | 'desc';
type OrderBy = Record<string, SortDir | { sort: SortDir; nulls?: 'first' | 'last' }>;

/** Порівняння для `orderBy`: дати — за часом, числа — за значенням, null — за `nulls` (типово last). */
function compareBy(a: MemRow, b: MemRow, orderBy: OrderBy[]): number {
  for (const spec of orderBy) {
    for (const [field, dir] of Object.entries(spec)) {
      const sort = typeof dir === 'string' ? dir : dir.sort;
      const nulls = typeof dir === 'string' ? 'last' : (dir.nulls ?? 'last');
      const x = a[field] ?? null;
      const y = b[field] ?? null;
      if (x === null && y === null) continue;
      if (x === null || y === null) return (x === null) === (nulls === 'first') ? -1 : 1;
      const xv = x instanceof Date ? x.getTime() : isNumeric(x) ? num(x) : String(x);
      const yv = y instanceof Date ? y.getTime() : isNumeric(y) ? num(y) : String(y);
      if (xv === yv) continue;
      const cmp = xv < yv ? -1 : 1;
      return sort === 'desc' ? -cmp : cmp;
    }
  }
  return 0;
}

/** Ключі `include` / `select`, для яких описано зв'язок: рядок віддається копією з цими полями. */
function withRelations(row: MemRow, args: unknown, relations: MemRelations): MemRow {
  if (!isPlainObject(args)) return row;
  const shape: unknown = isPlainObject(args.include) ? args.include : args.select;
  if (!isPlainObject(shape)) return row;
  const keys = Object.keys(shape).filter(k => relations[k] && shape[k]);
  if (keys.length === 0) return row;
  const copy: MemRow = { ...row };
  for (const k of keys) copy[k] = relations[k](row) ?? null;
  return copy;
}

type FindArgs = { where?: unknown; orderBy?: OrderBy | OrderBy[]; skip?: number; take?: number };

/**
 * Делегат Prisma поверх масиву рядків: читання фільтрують за `where`, запис змінює самі рядки.
 * `select` / `include` скалярів ігноруються — віддається рядок цілком (надмножина того, що просив
 * сервіс); поле-зв'язок, описане в `relations`, додається до копії рядка. `orderBy`, `skip`, `take`
 * — як у Prisma. `update` / `updateMany` розуміють `increment` / `decrement` / `set`; `where` —
 * `gt/gte/lt/lte`, складений унікальний ключ і фільтр через зв'язок, якщо його описано в `relations`.
 */
export function memoryTable(
  rows: MemRow[],
  defaults: () => MemRow = () => ({}),
  relations: MemRelations = {},
) {
  let seq = 0;
  const find = (args?: FindArgs) => {
    const hits = rows.filter(r => whereMatches(r, args?.where, relations));
    if (args?.orderBy) {
      const order = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy];
      hits.sort((a, b) => compareBy(a, b, order));
    }
    const from = args?.skip ?? 0;
    return args?.take === undefined ? hits.slice(from) : hits.slice(from, from + args.take);
  };
  const read = (args: unknown) => (row: MemRow) => withRelations(row, args, relations);
  const first = (args?: FindArgs) => {
    const hit = find(args)[0];
    return hit ? read(args)(hit) : null;
  };
  const notFound = () => Object.assign(new Error('No record found'), { code: 'P2025' });
  const insert = (data: MemRow): MemRow => {
    seq += 1;
    const row: MemRow = { id: `mem-${seq}`, ...defaults() };
    applyData(row, data);
    rows.push(row);
    return row;
  };
  return {
    rows,
    findFirst: vi.fn((args?: FindArgs) => Promise.resolve(first(args))),
    findUnique: vi.fn((args?: FindArgs) => Promise.resolve(first(args))),
    findFirstOrThrow: vi.fn((args?: FindArgs) => {
      const hit = first(args);
      return hit ? Promise.resolve(hit) : Promise.reject(notFound());
    }),
    findUniqueOrThrow: vi.fn((args?: FindArgs) => {
      const hit = first(args);
      return hit ? Promise.resolve(hit) : Promise.reject(notFound());
    }),
    findMany: vi.fn((args?: FindArgs) => Promise.resolve(find(args).map(read(args)))),
    count: vi.fn((args?: { where?: unknown }) => Promise.resolve(find(args).length)),
    aggregate: vi.fn(
      (args: { where?: unknown; _sum?: Record<string, boolean>; _count?: unknown }) => {
        const hits = find(args);
        const result: MemRow = {};
        if (args._sum) {
          const sum: MemRow = {};
          for (const field of Object.keys(args._sum)) {
            sum[field] = hits.length
              ? cents(hits.reduce((acc, r) => acc + num(r[field] ?? 0), 0))
              : null;
          }
          result._sum = sum;
        }
        if (args._count) result._count = hits.length;
        return Promise.resolve(result);
      },
    ),
    groupBy: vi.fn(
      (args: {
        by: string[];
        where?: unknown;
        _sum?: Record<string, boolean>;
        _count?: Record<string, boolean>;
      }) => {
        const groups = new Map<string, MemRow[]>();
        for (const hit of find(args)) {
          const key = JSON.stringify(args.by.map(f => hit[f] ?? null));
          groups.set(key, [...(groups.get(key) ?? []), hit]);
        }
        return Promise.resolve(
          Array.from(groups.values()).map(members => {
            const out: MemRow = {};
            for (const f of args.by) out[f] = members[0][f] ?? null;
            if (args._sum) {
              const sum: MemRow = {};
              for (const field of Object.keys(args._sum)) {
                sum[field] = members.reduce((acc, r) => acc + num(r[field] ?? 0), 0);
              }
              out._sum = sum;
            }
            if (args._count) {
              const count: MemRow = {};
              for (const field of Object.keys(args._count)) count[field] = members.length;
              out._count = count;
            }
            return out;
          }),
        );
      },
    ),
    create: vi.fn((args: { data: MemRow }) => Promise.resolve(read(args)(insert(args.data)))),
    createMany: vi.fn((args: { data: MemRow[] }) => {
      for (const data of args.data) insert(data);
      return Promise.resolve({ count: args.data.length });
    }),
    upsert: vi.fn((args: { where?: unknown; create: MemRow; update: MemRow }) => {
      const hit = find(args)[0];
      if (hit) {
        applyData(hit, args.update);
        return Promise.resolve(hit);
      }
      return Promise.resolve(insert(args.create));
    }),
    update: vi.fn((args: { where?: unknown; data: MemRow }) => {
      const hit = find(args)[0];
      if (!hit) return Promise.reject(notFound());
      applyData(hit, args.data);
      return Promise.resolve(hit);
    }),
    updateMany: vi.fn((args: { where?: unknown; data: MemRow }) => {
      const hits = find(args);
      for (const hit of hits) applyData(hit, args.data);
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
      // findMany за замовчуванням — порожньо: історія каси, крім самих рядків, дочитує сторно
      // до них (BR-CASH-023, `reversedBy`); кейси, яким потрібні рядки, задають їх `Once`.
      cashOperation: {
        create: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        aggregate: vi.fn(),
        groupBy: vi.fn(),
      },
      expenseCategory: { findFirst: vi.fn() },
      // Історія каси шукає ще й за назвою контрагента / працівника (план 2026-10-14, п. 3.7):
      // за замовчуванням збігів немає.
      counterparty: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      employee: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      garageBranch: { findFirst: vi.fn() },
      currency: { findFirst: vi.fn() },
      // Блокування каси перед читанням залишку (pg_advisory_xact_lock) — лише для видачі.
      $executeRaw: vi.fn().mockResolvedValue(1),
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
