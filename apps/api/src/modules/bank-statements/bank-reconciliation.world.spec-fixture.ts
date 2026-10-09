/**
 * «Світ» для спеків вихідних банківських платежів (BR-BANK-017…040): Prisma-підробка з даними
 * в пам'яті + моки сусідніх сервісів + збирання BankReconciliationService через DI-токени.
 *
 * НАВІЩО НЕ `mockResolvedValue`. Тести писались ДО реалізації: невідомо, чи сервіс читає рядок
 * до CAS чи після, одним запитом чи трьома. Тому підробка ВИКОНУЄ `where` над записами:
 *  · чужа організація / видалений запис справді «не знаходяться» — тест на tenant падає, якщо
 *    сервіс забув `orgId` чи `deletedAt` у where (мок із `null` цього не ловить);
 *  · `updateMany` — справжній CAS: друга спроба дає `count: 0` без ручного сценарію;
 *  · `$transaction(fn)` відкочує записи, зроблені через tx-клієнт, якщо колбек кинув, —
 *    так перевіряється «рядок не лишився MATCHED після збою каси».
 *
 * Клієнтів ДВА над одними даними: `root` (PrismaService) і `tx` (аргумент колбека `$transaction`).
 * У кожного свої шпигуни, тож видно, через який клієнт пішов запис, а третій аргумент
 * `createTransaction` / `createOperation` порівнюється з `tx` за ідентичністю.
 *
 * `select` виконується СУВОРО (повертаються лише вибрані поля) — як у справжньому Prisma:
 * поле, яке сервіс читає, але забув вибрати, буде `undefined` і тут.
 *
 * Фабрики, не const: `isolate: false` без `clearMocks` — спільний `vi.fn()` жив би між файлами.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { vi } from 'vitest';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CashService } from '../cash/cash.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import { PaymentsService } from '../payments/payments.service';
import { SettlementsService } from '../settlements/settlements.service';
import { SupplierPaymentsService } from '../supplier-payments/supplier-payments.service';
import { BankReconciliationService } from './bank-reconciliation.service';

export const ORG = 'org-1';
export const OTHER_ORG = 'org-2';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const USER = uuid(900);

/** Ідентифікатори засіяних записів. Усі унікальні в межах світу (зв'язки шукаються за id). */
export const ID = {
  tx: uuid(1),
  tx2: uuid(2),
  uah: uuid(10),
  usd: uuid(11),
  account: uuid(20),
  account2: uuid(21),
  accountUsd: uuid(22),
  accountForeign: uuid(23),
  accountDeleted: uuid(24),
  client: uuid(30),
  supplier: uuid(31),
  both: uuid(32),
  cpForeign: uuid(33),
  cpDeleted: uuid(34),
  supplier2: uuid(35),
  expense: uuid(40),
  expenseInactive: uuid(41),
  expenseIncome: uuid(42),
  expenseForeign: uuid(43),
  expenseDeleted: uuid(44),
  periodComputed: uuid(50),
  periodPaid: uuid(51),
  periodDraft: uuid(52),
  periodCancelled: uuid(53),
  periodForeign: uuid(54),
  periodDeleted: uuid(55),
  employee: uuid(60),
  employeeNoLine: uuid(61),
  cashUah: uuid(70),
  cashUsd: uuid(71),
  cashForeign: uuid(72),
  cashDeleted: uuid(73),
  po: uuid(80),
  poOtherSupplier: uuid(81),
  sp: uuid(90),
  spNew: uuid(91),
  cashOp: uuid(95),
} as const;

/** Власний IBAN рахунку `ID.account` (BR-BANK-020: не може стати IBAN контрагента). */
export const OWN_IBAN = 'UA213223130000026007233566001';
/** Дата операції тестового рядка: календарна дата, північ UTC (`@db.Date`). */
export const OP_DATE = new Date('2026-09-28T00:00:00.000Z');
export const ROW_AMOUNT = 1500.5;

type Rec = Record<string, unknown>;
type Where = Record<string, unknown>;
type Args = {
  where?: Where;
  data?: unknown;
  select?: Rec;
  include?: Rec;
  skipDuplicates?: boolean;
};

const NOT_RELATION = Symbol('not-relation');

/** Зворотні зв'язки (FK лежить у ІНШІЙ таблиці): модель → поле → [таблиця, FK, багато?]. */
const REVERSE: Record<string, Record<string, [string, string, boolean]>> = {
  payrollPeriod: {
    lines: ['payrollLine', 'periodId', true],
    bankTransactions: ['bankTransaction', 'payrollPeriodId', true],
  },
  supplierPayment: { bankTransaction: ['bankTransaction', 'supplierPaymentId', false] },
  cashOperation: { bankTransaction: ['bankTransaction', 'cashOperationId', false] },
  payment: { bankTransaction: ['bankTransaction', 'paymentId', false] },
  bankAccount: {
    bankTransactions: ['bankTransaction', 'bankAccountId', true],
    transfersIn: ['bankTransaction', 'transferBankAccountId', true],
  },
  counterparty: { bankTransactions: ['bankTransaction', 'counterpartyId', true] },
  expenseCategory: { bankTransactions: ['bankTransaction', 'expenseCategoryId', true] },
  employee: { bankTransactions: ['bankTransaction', 'employeeId', true] },
};

const SCALAR_OPS = new Set([
  'equals',
  'in',
  'notIn',
  'not',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'startsWith',
  'endsWith',
  'mode',
]);

const isPlainObject = (v: unknown): v is Rec =>
  typeof v === 'object' && v !== null && !(v instanceof Date) && !Array.isArray(v);
const isDecimalLike = (v: unknown): boolean =>
  isPlainObject(v) && typeof (v as { toNumber?: unknown }).toNumber === 'function';
const toArray = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);

function scalarEq(a: unknown, b: unknown): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  if (x instanceof Date || y instanceof Date) {
    return new Date(x as Date).getTime() === new Date(y as Date).getTime();
  }
  if (isDecimalLike(x) || isDecimalLike(y) || typeof x === 'number' || typeof y === 'number') {
    return Number(x) === Number(y);
  }
  return x === y;
}

const ordinal = (v: unknown): number => (v instanceof Date ? v.getTime() : Number(v));

function matchScalar(value: unknown, cond: unknown): boolean {
  if (!isPlainObject(cond) || isDecimalLike(cond)) return scalarEq(value, cond);
  const insensitive = cond.mode === 'insensitive';
  const text = (v: unknown): string => (insensitive ? String(v).toLowerCase() : String(v));
  return Object.entries(cond).every(([op, arg]) => {
    if (arg === undefined) return true;
    switch (op) {
      case 'equals':
        return scalarEq(value, arg);
      case 'in':
        return (arg as unknown[]).some(a => scalarEq(value, a));
      case 'notIn':
        return !(arg as unknown[]).some(a => scalarEq(value, a));
      case 'not':
        return !matchScalar(value, arg);
      case 'gt':
        return value != null && ordinal(value) > ordinal(arg);
      case 'gte':
        return value != null && ordinal(value) >= ordinal(arg);
      case 'lt':
        return value != null && ordinal(value) < ordinal(arg);
      case 'lte':
        return value != null && ordinal(value) <= ordinal(arg);
      case 'contains':
        return value != null && text(value).includes(text(arg));
      case 'startsWith':
        return value != null && text(value).startsWith(text(arg));
      case 'endsWith':
        return value != null && text(value).endsWith(text(arg));
      default:
        return true; // `mode` та невідомі оператори
    }
  });
}

/** Сховище світу: таблиці в пам'яті + журнал записів tx-клієнта для відкату. */
export class FakeDb {
  readonly tables: Record<string, Rec[]> = {};
  private journal: Array<() => void> | null = null;
  private seq = 1000;

  rows(model: string): Rec[] {
    return (this.tables[model] ??= []);
  }

  /** Покласти запис напряму (сетап тесту), повз шпигунів і журнал. */
  seed(model: string, rec: Rec): Rec {
    const full = { deletedAt: null, ...rec };
    this.rows(model).push(full);
    return full;
  }

  /** Живий запис зі сховища (для асертів стану ПІСЛЯ виклику). */
  get(model: string, id: string): Rec {
    const rec = this.rows(model).find(r => r.id === id);
    if (!rec) throw new Error(`У світі немає ${model} ${id}`);
    return rec;
  }

  nextId(): string {
    return uuid(this.seq++);
  }

  modelOf(rec: Rec): string {
    return Object.keys(this.tables).find(m => this.tables[m].includes(rec)) ?? '';
  }

  private anywhere(id: unknown): Rec | null {
    for (const list of Object.values(this.tables)) {
      const hit = list.find(r => r.id === id);
      if (hit) return hit;
    }
    return null;
  }

  relation(rec: Rec, key: string): unknown {
    const reverse = REVERSE[this.modelOf(rec)]?.[key];
    if (reverse) {
      const [table, fk, many] = reverse;
      const list = this.rows(table).filter(r => r[fk] === rec.id);
      return many ? list : (list[0] ?? null);
    }
    const fk = `${key}Id`;
    if (fk in rec) return rec[fk] == null ? null : this.anywhere(rec[fk]);
    return NOT_RELATION;
  }

  private matchRelation(rel: unknown, cond: unknown): boolean {
    if (cond === null) return rel === null || (Array.isArray(rel) && rel.length === 0);
    if (!isPlainObject(cond)) return false;
    if (Array.isArray(rel)) {
      const list = rel as Rec[];
      if ('some' in cond && !list.some(r => this.matches(r, cond.some as Where))) return false;
      if ('none' in cond && list.some(r => this.matches(r, cond.none as Where))) return false;
      if ('every' in cond && !list.every(r => this.matches(r, cond.every as Where))) return false;
      return true;
    }
    const one = rel as Rec | null;
    if ('is' in cond || 'isNot' in cond) {
      if ('is' in cond) {
        const ok = cond.is === null ? one === null : !!one && this.matches(one, cond.is as Where);
        if (!ok) return false;
      }
      if ('isNot' in cond) {
        const hit =
          cond.isNot === null ? one === null : !!one && this.matches(one, cond.isNot as Where);
        if (hit) return false;
      }
      return true;
    }
    return !!one && this.matches(one, cond);
  }

  matches(rec: Rec, where: Where | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, cond]) => {
      if (cond === undefined) return true;
      if (key === 'AND') return toArray(cond as Where | Where[]).every(w => this.matches(rec, w));
      if (key === 'OR') return (cond as Where[]).some(w => this.matches(rec, w));
      if (key === 'NOT') return !toArray(cond as Where | Where[]).some(w => this.matches(rec, w));
      if (!(key in rec)) {
        const rel = this.relation(rec, key);
        if (rel !== NOT_RELATION) return this.matchRelation(rel, cond);
      }
      // Об'єкт без жодного скалярного оператора на скалярному полі — фільтр, якого підробка
      // не розуміє: краще гучно впасти, ніж мовчки «знайти все».
      if (isPlainObject(cond) && !isDecimalLike(cond)) {
        const ops = Object.keys(cond);
        if (ops.length > 0 && !ops.some(o => SCALAR_OPS.has(o))) {
          throw new Error(
            `FakeDb: непідтримуваний фільтр ${this.modelOf(rec)}.${key} = ${JSON.stringify(cond)}`,
          );
        }
      }
      return matchScalar(rec[key], cond);
    });
  }

  /** Проєкція запису за `select` / `include` (суворий select, зв'язки підтягуються). */
  project(rec: Rec | null, args: unknown): Rec | null {
    if (!rec) return null;
    const a = isPlainObject(args) ? (args as Args) : {};
    const out: Rec = a.select ? {} : { ...rec };
    const picks = a.select ?? a.include ?? {};
    for (const [key, sub] of Object.entries(picks)) {
      if (!sub) continue;
      if (key === '_count') {
        const counted = isPlainObject(sub) && isPlainObject(sub.select) ? sub.select : {};
        out._count = Object.fromEntries(
          Object.keys(counted).map(k => {
            const rel = this.relation(rec, k);
            return [k, Array.isArray(rel) ? rel.length : 0];
          }),
        );
        continue;
      }
      if (key in rec) {
        out[key] = rec[key];
        continue;
      }
      const rel = this.relation(rec, key);
      if (rel === NOT_RELATION) {
        out[key] = undefined;
      } else if (Array.isArray(rel)) {
        const nestedWhere = isPlainObject(sub) ? (sub.where as Where | undefined) : undefined;
        out[key] = (rel as Rec[])
          .filter(r => this.matches(r, nestedWhere))
          .map(r => this.project(r, sub));
      } else {
        out[key] = this.project(rel as Rec | null, sub);
      }
    }
    return out;
  }

  write(rec: Rec, data: Rec, journaled: boolean): void {
    if (journaled && this.journal) {
      const before = { ...rec };
      this.journal.push(() => {
        for (const k of Object.keys(rec)) delete rec[k];
        Object.assign(rec, before);
      });
    }
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (isPlainObject(value) && !isDecimalLike(value)) {
        if ('connect' in value) rec[`${key}Id`] = (value.connect as Rec).id;
        else if ('disconnect' in value) rec[`${key}Id`] = null;
        else if ('set' in value) rec[key] = value.set;
        else if ('increment' in value) rec[key] = Number(rec[key] ?? 0) + Number(value.increment);
        else if ('decrement' in value) rec[key] = Number(rec[key] ?? 0) - Number(value.decrement);
        else rec[key] = value; // JSON-поле (rawData)
        continue;
      }
      rec[key] = value;
    }
  }

  insert(model: string, data: Rec, journaled: boolean): Rec {
    const rec: Rec = { id: this.nextId(), deletedAt: null, createdAt: new Date() };
    this.write(rec, data, false);
    const list = this.rows(model);
    list.push(rec);
    if (journaled && this.journal) {
      this.journal.push(() => {
        const at = list.indexOf(rec);
        if (at >= 0) list.splice(at, 1);
      });
    }
    return rec;
  }

  begin(): void {
    this.journal = [];
  }
  commit(): void {
    this.journal = null;
  }
  rollback(): void {
    const undo = this.journal ?? [];
    this.journal = null;
    for (const step of undo.reverse()) step();
  }
}

/** vi.fn над синхронною реалізацією: повертає Promise (кинуте → reject). */
function asyncMock<A extends unknown[], R>(impl: (...args: A) => R) {
  return vi.fn((...args: A): Promise<R> => {
    try {
      return Promise.resolve(impl(...args));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

function notFound(model: string): Error {
  return new Prisma.PrismaClientKnownRequestError(`No ${model} found`, {
    code: 'P2025',
    clientVersion: 'fake',
  });
}

function makeModel(db: FakeDb, model: string, journaled: boolean) {
  const find = (args?: Args): Rec[] => db.rows(model).filter(r => db.matches(r, args?.where));
  const first = (args?: Args) => db.project(find(args)[0] ?? null, args);
  const firstOrThrow = (args?: Args) => {
    const rec = find(args)[0];
    if (!rec) throw notFound(model);
    return db.project(rec, args);
  };
  return {
    findFirst: asyncMock(first),
    findUnique: asyncMock(first),
    findFirstOrThrow: asyncMock(firstOrThrow),
    findUniqueOrThrow: asyncMock(firstOrThrow),
    findMany: asyncMock((args?: Args) => find(args).map(r => db.project(r, args))),
    count: asyncMock((args?: Args) => find(args).length),
    aggregate: asyncMock((_args?: Args) => ({ _sum: {}, _count: 0 })),
    updateMany: asyncMock((args: Args) => {
      const hit = find(args);
      for (const rec of hit) db.write(rec, args.data as Rec, journaled);
      return { count: hit.length };
    }),
    update: asyncMock((args: Args) => {
      const rec = find(args)[0];
      if (!rec) throw notFound(model);
      db.write(rec, args.data as Rec, journaled);
      return db.project(rec, args);
    }),
    create: asyncMock((args: Args) =>
      db.project(db.insert(model, args.data as Rec, journaled), args),
    ),
    createMany: asyncMock((args: Args) => {
      let count = 0;
      for (const data of toArray(args.data as Rec | Rec[])) {
        // Унікальний ключ staging-рядка: orgId + bankAccountId + externalId (BR-BANK-002).
        const duplicate =
          model === 'bankTransaction' &&
          db
            .rows(model)
            .some(
              r =>
                r.orgId === data.orgId &&
                r.bankAccountId === data.bankAccountId &&
                r.externalId === data.externalId,
            );
        if (duplicate && args.skipDuplicates) continue;
        db.insert(model, data, journaled);
        count += 1;
      }
      return { count };
    }),
    // Жорстке видалення в проєкті заборонене: шпигуни лише фіксують виклик, даних не чіпають.
    delete: asyncMock((_args?: Args) => ({})),
    deleteMany: asyncMock((_args?: Args) => ({ count: 0 })),
  };
}

export type FakeModel = ReturnType<typeof makeModel>;
export type FakeClient = Record<string, FakeModel> & {
  $transaction: ReturnType<typeof vi.fn>;
  $queryRaw: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
};

/** Клієнт над сховищем: модель створюється при першому зверненні (будь-яке ім'я). */
function makeClient(db: FakeDb, journaled: boolean, tx: () => FakeClient): FakeClient {
  const target: Record<string, unknown> = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    $transaction: vi.fn((arg: unknown) => {
      if (typeof arg !== 'function') {
        return Array.isArray(arg) ? Promise.all(arg as unknown[]) : Promise.resolve(arg);
      }
      db.begin();
      return Promise.resolve()
        .then(() => (arg as (client: FakeClient) => unknown)(tx()))
        .then(
          res => {
            db.commit();
            return res;
          },
          (err: unknown) => {
            db.rollback();
            throw err;
          },
        );
    }),
  };
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (!(prop in t)) t[prop] = makeModel(db, prop, journaled);
      return t[prop];
    },
  }) as FakeClient;
}

/** Мок сервісу, якого спек не чекає: будь-який метод — vi.fn, що резолвиться в undefined. */
export function autoMock(): Record<string, ReturnType<typeof vi.fn>> {
  const target: Record<string, ReturnType<typeof vi.fn>> = {};
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      return (t[prop] ??= vi.fn().mockResolvedValue(undefined));
    },
  });
}

export const dec = (n: number): Prisma.Decimal => new Prisma.Decimal(n);

/** Стан рядка, якого рознесення не торкнулось (або який повністю звільнено). */
export const FREE_ROW = {
  status: 'UNMATCHED',
  matchedType: null,
  counterpartyId: null,
  paymentId: null,
  supplierPaymentId: null,
  expenseCategoryId: null,
  payrollPeriodId: null,
  employeeId: null,
  transferBankAccountId: null,
  cashOperationId: null,
} as const;

/** Повний рядок BankTransaction (усі колонки схеми, що читає сервіс і mapper). */
export function bankRow(over: Rec = {}): Rec {
  return {
    id: ID.tx,
    orgId: ORG,
    bankAccountId: ID.account,
    direction: 'OUT',
    amount: dec(ROW_AMOUNT),
    currencyId: ID.uah,
    amountBase: dec(ROW_AMOUNT),
    rateUsed: dec(1),
    operationDate: OP_DATE,
    payerName: 'ТОВ Постачальник',
    payerIban: null,
    payerEdrpou: null,
    purpose: 'Оплата за товар',
    externalId: 'ext-1',
    source: 'FILE_IMPORT',
    status: 'UNMATCHED',
    matchedType: null,
    counterpartyId: null,
    paymentId: null,
    matchConfidence: null,
    rawData: null,
    ignoreReason: null,
    supplierPaymentId: null,
    expenseCategoryId: null,
    payrollPeriodId: null,
    employeeId: null,
    transferBankAccountId: null,
    cashOperationId: null,
    createdBy: null,
    matchedAt: null,
    matchedBy: null,
    unmatchReason: null,
    unmatchedAt: null,
    unmatchedBy: null,
    createdAt: new Date('2026-09-28T09:00:00.000Z'),
    updatedAt: new Date('2026-09-28T09:00:00.000Z'),
    deletedAt: null,
    ...over,
  };
}

/** Проведена оплата постачальнику, що точно відповідає рядку `bankRow()` (BR-BANK-027). */
export function supplierPaymentRow(over: Rec = {}): Rec {
  return {
    id: ID.sp,
    orgId: ORG,
    supplierId: ID.supplier,
    purchaseOrderId: null,
    sourceType: 'BANK_ACCOUNT',
    bankAccountId: ID.account,
    cashRegisterId: null,
    number: 'ОПП-20260928-000001',
    status: 'CONFIRMED',
    amount: dec(ROW_AMOUNT),
    currencyId: ID.uah,
    totalAmountBase: dec(ROW_AMOUNT),
    rateUsed: dec(1),
    method: 'bank',
    notes: null,
    documentDate: OP_DATE,
    createdAt: new Date('2026-09-28T08:00:00.000Z'),
    updatedAt: new Date('2026-09-28T08:00:00.000Z'),
    deletedAt: null,
    ...over,
  };
}

function seedWorld(db: FakeDb): void {
  db.seed('currency', { id: ID.uah, code: 'UAH' });
  db.seed('currency', { id: ID.usd, code: 'USD' });

  const account = (id: string, over: Rec = {}) =>
    db.seed('bankAccount', {
      id,
      orgId: ORG,
      name: `Рахунок ${id.slice(-2)}`,
      ibanUA: `UA${id.slice(-12)}00000000000000000`,
      currencyId: ID.uah,
      branchId: null,
      ...over,
    });
  account(ID.account, { ibanUA: OWN_IBAN });
  account(ID.account2);
  account(ID.accountUsd, { currencyId: ID.usd });
  account(ID.accountForeign, { orgId: OTHER_ORG });
  account(ID.accountDeleted, { deletedAt: new Date('2026-01-01') });

  const cp = (id: string, type: string, over: Rec = {}) =>
    db.seed('counterparty', {
      id,
      orgId: ORG,
      type,
      companyName: `Контрагент ${id.slice(-2)}`,
      firstName: null,
      lastName: null,
      iban: null,
      edrpou: null,
      ...over,
    });
  cp(ID.client, 'CLIENT');
  cp(ID.supplier, 'SUPPLIER');
  cp(ID.supplier2, 'SUPPLIER');
  cp(ID.both, 'BOTH');
  cp(ID.cpForeign, 'BOTH', { orgId: OTHER_ORG });
  cp(ID.cpDeleted, 'BOTH', { deletedAt: new Date('2026-01-01') });

  const category = (id: string, over: Rec = {}) =>
    db.seed('expenseCategory', {
      id,
      orgId: ORG,
      parentId: null,
      name: `Стаття ${id.slice(-2)}`,
      type: 'EXPENSE',
      isActive: true,
      ...over,
    });
  category(ID.expense);
  category(ID.expenseInactive, { isActive: false });
  category(ID.expenseIncome, { type: 'INCOME' });
  category(ID.expenseForeign, { orgId: OTHER_ORG });
  category(ID.expenseDeleted, { deletedAt: new Date('2026-01-01') });

  const period = (id: string, status: string, over: Rec = {}) =>
    db.seed('payrollPeriod', {
      id,
      orgId: ORG,
      branchId: null,
      periodStart: new Date('2026-09-01'),
      periodEnd: new Date('2026-09-30'),
      status,
      paidAt: null,
      paidBy: null,
      ...over,
    });
  period(ID.periodComputed, 'COMPUTED');
  period(ID.periodPaid, 'PAID', { paidAt: new Date('2026-10-01') });
  period(ID.periodDraft, 'DRAFT');
  period(ID.periodCancelled, 'CANCELLED');
  period(ID.periodForeign, 'COMPUTED', { orgId: OTHER_ORG });
  period(ID.periodDeleted, 'COMPUTED', { deletedAt: new Date('2026-01-01') });

  for (const id of [ID.employee, ID.employeeNoLine]) {
    db.seed('employee', { id, orgId: ORG, firstName: 'Іван', lastName: `Майстер ${id.slice(-2)}` });
  }
  // Рядок зарплати є лише в ID.employee, і в обох придатних періодах. У ID.employeeNoLine — жодного.
  for (const periodId of [ID.periodComputed, ID.periodPaid]) {
    db.seed('payrollLine', {
      id: db.nextId(),
      orgId: ORG,
      periodId,
      employeeId: ID.employee,
      accruedAmount: dec(12000),
      paidAmount: dec(0),
    });
  }

  const register = (id: string, over: Rec = {}) =>
    db.seed('cashRegister', {
      id,
      orgId: ORG,
      name: `Каса ${id.slice(-2)}`,
      currencyId: ID.uah,
      branchId: uuid(700),
      isFiscal: false,
      ...over,
    });
  register(ID.cashUah);
  register(ID.cashUsd, { currencyId: ID.usd });
  register(ID.cashForeign, { orgId: OTHER_ORG });
  register(ID.cashDeleted, { deletedAt: new Date('2026-01-01') });

  const order = (id: string, supplierId: string, number: string) =>
    db.seed('purchaseOrder', {
      id,
      orgId: ORG,
      supplierId,
      number,
      status: 'ORDERED',
      currencyId: ID.uah,
      totalAmount: dec(5000),
      paidAmount: dec(0),
      paidAt: null,
    });
  order(ID.po, ID.supplier, '4521');
  order(ID.poOtherSupplier, ID.supplier2, '4522');
}

/**
 * Моки сусідніх сервісів. Там, де правило спирається на перевірку СУСІДА (роль постачальника,
 * належність замовлення — BR-BANK-028 «з усіма його правилами»), мок її відтворює: тест не знає,
 * чи BankReconciliationService перевіряє сам, чи покладається на SupplierPaymentsService.create.
 */
function makeDeps(db: FakeDb, root: FakeClient) {
  const live = (model: string, id: unknown) =>
    db.rows(model).find(r => r.id === id && r.orgId === ORG && r.deletedAt == null);

  const supplierPayments = {
    create: asyncMock((orgId: string, dto: Rec, _userId?: string) => {
      const supplier = live('counterparty', dto.supplierId);
      if (!supplier || orgId !== ORG) throw new NotFoundException('Контрагента не знайдено');
      if (supplier.type === 'CLIENT')
        throw new BadRequestException('Контрагент не є постачальником');
      if (dto.purchaseOrderId) {
        const po = live('purchaseOrder', dto.purchaseOrderId);
        if (!po) throw new NotFoundException('Замовлення постачальнику не знайдено');
        if (po.supplierId !== dto.supplierId) {
          throw new BadRequestException('Замовлення не належить цьому постачальнику');
        }
      }
      const account = live('bankAccount', dto.bankAccountId);
      // Перша чернетка має відомий id (ID.spNew), наступні — згенеровані (повторне рознесення).
      const taken = db.rows('supplierPayment').some(r => r.id === ID.spNew);
      const rec = db.insert(
        'supplierPayment',
        supplierPaymentRow({
          id: taken ? db.nextId() : ID.spNew,
          status: 'DRAFT',
          supplierId: dto.supplierId,
          purchaseOrderId: dto.purchaseOrderId ?? null,
          sourceType: dto.sourceType,
          bankAccountId: dto.bankAccountId ?? null,
          amount: dec(Number(dto.amount)),
          currencyId: account?.currencyId ?? ID.uah,
          totalAmountBase: null,
          rateUsed: null,
          number: 'ОПП-20261009-000007',
        }),
        false,
      );
      return { ...rec, amount: Number(dto.amount) };
    }),
    confirm: asyncMock((_orgId: string, id: string, _userId: string, _opts?: unknown) => {
      const rec = db.get('supplierPayment', id);
      rec.status = 'CONFIRMED';
      return { ...rec, amount: Number(rec.amount) };
    }),
    cancel: asyncMock((_orgId: string, id: string, ..._rest: unknown[]) => {
      const rec = db.get('supplierPayment', id);
      rec.status = 'CANCELLED';
      return { ...rec, amount: Number(rec.amount) };
    }),
    findOne: asyncMock((_orgId: string, id: string) => db.get('supplierPayment', id)),
  };

  const settlements = { createTransaction: vi.fn().mockResolvedValue(undefined) };

  // Касова операція пишеться ЧЕРЕЗ ПЕРЕДАНИЙ клієнт: якщо сервіс передав tx — запис відкотиться
  // разом із транзакцією; якщо не передав — лишиться (і тест на «одну транзакцію» це побачить).
  const cash = {
    createOperation: vi.fn(async (orgId: string, input: Rec, tx?: FakeClient) => {
      const created = await (tx ?? root).cashOperation.create({
        data: { orgId, ...input, amount: dec(Number(input.amount)) },
      });
      return { ...created, amount: Number(input.amount) };
    }),
  };

  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const payments = { create: vi.fn().mockResolvedValue({ id: uuid(990) }) };

  const exchange = {
    resolveBaseConversion: vi.fn(
      (_o: string, _c: string, _d: Date, amount: number, _fallback?: boolean) =>
        Promise.resolve({ rateUsed: 1, amountBase: amount }),
    ),
    getBaseCurrency: vi.fn().mockResolvedValue({ id: ID.uah, code: 'UAH' }),
    requireBaseCurrencyId: vi.fn().mockResolvedValue(ID.uah),
    // Справжня логіка: null ≡ базова валюта.
    sameCurrency: vi.fn((_o: string, a: string | null, b: string | null) =>
      Promise.resolve((a ?? ID.uah) === (b ?? ID.uah)),
    ),
  };

  return { supplierPayments, settlements, cash, audit, payments, exchange };
}

export type WorldDeps = ReturnType<typeof makeDeps>;

/**
 * Зібрати BankReconciliationService з провайдерами ЗА ТОКЕНАМИ КЛАСІВ — порядок аргументів
 * конструктора тестам байдужий. Залежність, якої тут не передбачено, отримує `autoMock()`.
 */
export async function buildService(
  prisma: unknown,
  deps: Partial<Record<keyof WorldDeps, unknown>> = {},
): Promise<BankReconciliationService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      BankReconciliationService,
      { provide: PrismaService, useValue: prisma },
      { provide: ExchangeRatesService, useValue: deps.exchange ?? autoMock() },
      { provide: PaymentsService, useValue: deps.payments ?? autoMock() },
      { provide: SupplierPaymentsService, useValue: deps.supplierPayments ?? autoMock() },
      { provide: SettlementsService, useValue: deps.settlements ?? autoMock() },
      { provide: CashService, useValue: deps.cash ?? autoMock() },
      { provide: AuditService, useValue: deps.audit ?? autoMock() },
    ],
  })
    .useMocker(() => autoMock())
    .compile();
  return moduleRef.get(BankReconciliationService);
}

export async function makeWorld() {
  const db = new FakeDb();
  seedWorld(db);
  const clients: { tx?: FakeClient } = {};
  const tx = (clients.tx = makeClient(db, true, () => clients.tx!));
  const prisma = makeClient(db, false, () => tx);
  const deps = makeDeps(db, prisma);
  const service = await buildService(prisma, deps);

  /** Усі виклики `<model>.<method>` на ОБОХ клієнтах (root + tx), у вигляді списку аргументів. */
  const calls = (model: string, method: keyof FakeModel): Args[] =>
    [prisma, tx].flatMap(c => c[model][method].mock.calls.map(call => call[0] as Args));

  return {
    db,
    prisma,
    tx,
    service,
    ...deps,
    calls,
    /** Покласти рядок виписки у світ. */
    addRow: (over: Rec = {}) => db.seed('bankTransaction', bankRow(over)),
    /** Живий рядок виписки (стан ПІСЛЯ виклику сервісу). */
    row: (id: string = ID.tx) => db.get('bankTransaction', id),
    /** CAS-захоплення: updateMany рядка виписки з `data.status = <to>` на будь-якому клієнті. */
    statusWrites: (to: string): Args[] =>
      calls('bankTransaction', 'updateMany').filter(
        a => (a.data as Rec | undefined)?.status === to,
      ),
    /** Змусити наступний CAS рядка «програти» (гонка): count = 0 на обох клієнтах. */
    loseNextCas: () => {
      for (const c of [prisma, tx])
        c.bankTransaction.updateMany.mockResolvedValueOnce({ count: 0 });
    },
  };
}

export type World = Awaited<ReturnType<typeof makeWorld>>;

/** Жоден грошовий побічний ефект не стався (проведення, каса, оплата постачальнику, Payment). */
export function effectCalls(w: World): Record<string, number> {
  return {
    'settlements.createTransaction': w.settlements.createTransaction.mock.calls.length,
    'cash.createOperation': w.cash.createOperation.mock.calls.length,
    'supplierPayments.create': w.supplierPayments.create.mock.calls.length,
    'supplierPayments.confirm': w.supplierPayments.confirm.mock.calls.length,
    'supplierPayments.cancel': w.supplierPayments.cancel.mock.calls.length,
    'payments.create': w.payments.create.mock.calls.length,
  };
}

export const NO_EFFECTS: Record<string, number> = {
  'settlements.createTransaction': 0,
  'cash.createOperation': 0,
  'supplierPayments.create': 0,
  'supplierPayments.confirm': 0,
  'supplierPayments.cancel': 0,
  'payments.create': 0,
};
