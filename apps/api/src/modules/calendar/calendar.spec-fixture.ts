import { vi } from 'vitest';

// Сховище слотів у пам'яті для аспектних спеків календаря й онлайн-запису.
//
// Навіщо: conflict probe — це Prisma `where`. Мок `findFirst.mockResolvedValue(null)` його не
// виконує, тож `lt` → `lte`, зниклий `NOT: { id }` чи доданий фільтр за статусом лишаються
// непоміченими (перевірено мутаціями 2026-10-07: 9 із 11 правок проби не валили жодного тесту).
// Тут `where` справді обчислюється над рядками — тест описує ПОВЕДІНКУ («дотик меж не є
// перетином»), а не форму запиту.
//
// Factory, не const: `isolate: false` без `clearMocks` — спільний стан протікав би між файлами.

type Where = Record<string, unknown>;
type Row = Record<string, unknown>;

export interface FakeSlot extends Row {
  id: string;
  orgId: string;
  liftId: string | null;
  employeeId: string | null;
  workOrderId: string | null;
  counterpartyId: string | null;
  vehicleId: string | null;
  parentSlotId: string | null;
  startAt: Date;
  endAt: Date;
  status: string;
  type: string;
  notes: string | null;
  deletedAt: Date | null;
  /** Наряд запису — для фільтра через зв'язок (`workOrder: { is }`); `null` — без наряду. */
  workOrder?: { deletedAt: Date | null; number?: string; status?: string } | null;
}

export const FAKE_ORG_ID = 'org-1';
export const FAKE_BRANCH_ID = 'branch-1';

function comparable(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

function same(a: unknown, b: unknown): boolean {
  return comparable(a) === comparable(b);
}

/**
 * Обчислює підмножину Prisma `where`, якою користуються календар і онлайн-запис: рівність
 * скалярів (зокрема `null`), `lt/lte/gt/gte/not/in`, `OR`, `AND`, `NOT`, зв'язок-список `some`
 * (рядок тримає масив пов'язаних рядків, напр. `employeeLifts`) і зв'язок-один `is` (рядок тримає
 * пов'язаний рядок або `null`; `is` для `null` — не збіг, як у Prisma). `undefined` — «без фільтра»,
 * як у Prisma. Невідоме поле чи оператор — помилка, а не мовчазне «збіглося»: інакше фільтр,
 * якого сховище не розуміє, виглядав би як пройдений тест.
 */
export function matchesWhere(row: Row, where: Where): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === 'OR') {
      if (!(cond as Where[]).some(w => matchesWhere(row, w))) return false;
      continue;
    }
    if (key === 'AND') {
      if (!(cond as Where[]).every(w => matchesWhere(row, w))) return false;
      continue;
    }
    if (key === 'NOT') {
      if (matchesWhere(row, cond as Where)) return false;
      continue;
    }
    if (!(key in row)) throw new Error(`fake store: поле «${key}» відсутнє в рядку`);
    const value = row[key];
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) {
      if (!same(value, cond)) return false;
      continue;
    }
    for (const [op, operand] of Object.entries(cond as Where)) {
      const a = comparable(value) as number;
      const b = comparable(operand) as number;
      if (op === 'lt') {
        if (!(a < b)) return false;
      } else if (op === 'lte') {
        if (!(a <= b)) return false;
      } else if (op === 'gt') {
        if (!(a > b)) return false;
      } else if (op === 'gte') {
        if (!(a >= b)) return false;
      } else if (op === 'not') {
        // Prisma/SQL: `<> x` не повертає рядки з NULL.
        if (same(value, operand) || (value === null && operand !== null)) return false;
      } else if (op === 'in') {
        if (!(operand as unknown[]).some(o => same(value, o))) return false;
      } else if (op === 'is') {
        if (value === null || typeof value !== 'object') return false; // зв'язку немає — `is` не збігається
        if (!matchesWhere(value as Row, operand as Where)) return false;
      } else if (op === 'some') {
        if (!Array.isArray(value)) throw new Error(`fake store: «${key}» не є списком для some`);
        if (!(value as Row[]).some(el => matchesWhere(el, operand as Where))) return false;
      } else {
        throw new Error(`fake store: оператор «${op}» не підтримано`);
      }
    }
  }
  return true;
}

let seq = 0;

/** Слот із дефолтами: BOOKED / WORK, невидалений, без ресурсів. */
export function fakeSlot(over: Partial<FakeSlot> & { startAt: Date; endAt: Date }): FakeSlot {
  seq += 1;
  return {
    id: `slot-${seq}`,
    orgId: FAKE_ORG_ID,
    liftId: null,
    employeeId: null,
    workOrderId: null,
    counterpartyId: null,
    vehicleId: null,
    parentSlotId: null,
    status: 'BOOKED',
    type: 'WORK',
    notes: null,
    deletedAt: null,
    workOrder: null,
    ...over,
  };
}

const NO_RELATIONS = { counterparty: null, vehicle: null, workOrder: null };

/**
 * Prisma-мок поверх масиву слотів: `findFirst` / `findMany` обчислюють `where`, `create` і
 * `update` змінюють масив. `$transaction(cb)` передає той самий `calendarSlot` як `tx`.
 * Підйомник «існує» для будь-якого id, механік — для будь-якого id і підйомника (BR-CAL-012
 * стереже `calendar.mechanic-lift.spec.ts` зі справжньою таблицею працівників). Підйомник — у
 * філії `FAKE_BRANCH_ID` з робочим днем 08:00–20:00 (явні налаштування філії, не типові години):
 * години в спеках конфліктів розраховані на це вікно. Запис без підйомника — типові 09–18.
 */
export function buildSlotStorePrisma(rows: FakeSlot[]) {
  const findFirst = vi.fn(({ where }: { where: Where }) =>
    Promise.resolve(rows.find(r => matchesWhere(r, where)) ?? null),
  );
  const findMany = vi.fn(({ where }: { where: Where }) =>
    Promise.resolve(rows.filter(r => matchesWhere(r, where))),
  );
  const create = vi.fn(({ data }: { data: Partial<FakeSlot> & { startAt: Date; endAt: Date } }) => {
    const row = fakeSlot(data);
    rows.push(row);
    return Promise.resolve({ ...row, ...NO_RELATIONS });
  });
  const update = vi.fn(({ where, data }: { where: Where; data: Partial<FakeSlot> }) => {
    const row = rows.find(r => matchesWhere(r, where));
    if (!row) return Promise.reject(new Error('fake store: слот для update не знайдено'));
    Object.assign(row, data);
    return Promise.resolve({ ...row, ...NO_RELATIONS });
  });
  const calendarSlot = { findFirst, findMany, create, update };
  const exists = () =>
    vi.fn(({ where }: { where: { id: string } }) => Promise.resolve({ id: where.id }));

  return {
    calendarSlot,
    lift: {
      findFirst: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve({ id: where.id, zone: { branchId: FAKE_BRANCH_ID } }),
      ),
    },
    employee: { findFirst: exists() },
    workOrder: { findFirst: exists() },
    counterparty: { findFirst: exists() },
    vehicle: { findFirst: exists() },
    branchSettings: {
      findFirst: vi.fn().mockResolvedValue({ workStartTime: '08:00', workEndTime: '20:00' }),
    },
    $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({ calendarSlot })),
    _rows: rows,
    _create: create,
    _update: update,
  };
}
