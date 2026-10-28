import {
  PNL_EXPENSE_CASH_REASON_OPTIONS,
  PNL_EXPENSE_CASH_REASON_REQUIRED,
  PNL_INCOME_CASH_REASON_OPTIONS,
  PNL_SETTINGS_DEFAULTS,
  type CashReasonValue,
} from '@sto/shared';
import { money, sumMoney } from '../../common/utils/money';

/**
 * BR-RPT-030 — чисті функції звіту P&L (прибутки й збитки): місяці періоду, розподіл зарплати
 * між місяцями, згортання дерева статей. Без бази — тестуються напряму (`pnl.calc.spec.ts`).
 *
 * Місяць — київський календарний, ключ `YYYY-MM`. Межі звіту — календарні дати `YYYY-MM-DD`.
 */

/** Найбільший період звіту P&L у місяцях (BR-RPT-030). */
export const PNL_MAX_MONTHS = 24;

/** Статуси періоду зарплати, нарахування яких входять у P&L (DRAFT і CANCELLED — ні). */
export const PNL_PAYROLL_STATUSES: readonly string[] = ['COMPUTED', 'PAID'];

/**
 * Налаштування звіту, за якими рахуються пп. 4–6 (рішення власника 2026-10-29: «винеси в
 * налаштування звіту»). Зберігаються в `OrganisationSettings`, тут — уже нормалізовані.
 */
export interface PnlSettings {
  /** Приводи каси IN зі статтею типу INCOME, що є «іншим доходом» (п. 6). */
  incomeCashReasons: CashReasonValue[];
  /** Приводи каси OUT, що є витратою (п. 5); `EXPENSE` — завжди. */
  expenseCashReasons: CashReasonValue[];
  /** Попереджати «зарплату не розраховано» і про місяці, що ще не почалися (п. 4). */
  warnFuturePayroll: boolean;
}

export interface PnlSettingsSource {
  pnlIncomeCashReasons?: readonly string[] | null;
  pnlExpenseCashReasons?: readonly string[] | null;
  pnlWarnFuturePayroll?: boolean | null;
}

/**
 * Нормалізує налаштування організації для P&L: лише дозволені приводи (`PNL_*_OPTIONS`, у їхньому
 * порядку, без повторів), «Витрата» — завжди серед витрат; відсутнє поле (старий кеш налаштувань,
 * налаштування недоступні) — типове значення, тобто поведінка до появи налаштувань.
 */
export function resolvePnlSettings(src: PnlSettingsSource | null | undefined): PnlSettings {
  const pick = <T extends CashReasonValue>(options: readonly T[], chosen: readonly string[]): T[] =>
    options.filter(o => chosen.includes(o));
  return {
    incomeCashReasons: pick(
      PNL_INCOME_CASH_REASON_OPTIONS,
      src?.pnlIncomeCashReasons ?? PNL_SETTINGS_DEFAULTS.pnlIncomeCashReasons,
    ),
    expenseCashReasons: pick(PNL_EXPENSE_CASH_REASON_OPTIONS, [
      ...(src?.pnlExpenseCashReasons ?? PNL_SETTINGS_DEFAULTS.pnlExpenseCashReasons),
      PNL_EXPENSE_CASH_REASON_REQUIRED,
    ]),
    warnFuturePayroll: src?.pnlWarnFuturePayroll ?? PNL_SETTINGS_DEFAULTS.pnlWarnFuturePayroll,
  };
}

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` → мить UTC-півночі (так Prisma віддає й приймає `@db.Date`). */
const dayUtc = (ymd: string): number => Date.parse(`${ymd}T00:00:00.000Z`);

/** Мить UTC-півночі → `YYYY-MM-DD`. */
const ymdOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Місяці `YYYY-MM` від місяця `from` до місяця `to` включно. */
export function monthsBetween(from: string, to: string): string[] {
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  const out: string[] = [];
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** Перший і останній день місяця `YYYY-MM` як `YYYY-MM-DD`. */
function monthBounds(month: string): { first: string; last: string } {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${String(lastDay).padStart(2, '0')}` };
}

export interface PnlPayrollPeriod {
  /** `@db.Date` — UTC-північ календарного дня. */
  periodStart: Date;
  periodEnd: Date;
  status: string;
  deletedAt: Date | null;
  /** Σ `PayrollLine.accruedAmount` періоду. */
  accrued: number;
}

/**
 * BR-RPT-030 п. 4 — зарплата по місяцях звіту.
 *
 * Нарахування періоду COMPUTED / PAID (не видаленого) ділиться порівну між календарними днями
 * періоду; місяцю звіту дістаються дні, що лежать і в місяці, і в межах `from..to`. Копійки — без
 * втрат: накопичена сума до дня k = round(total × k / D), частка відрізка — різниця двох таких
 * сум, тож частки всього періоду в сумі дають рівно total.
 *
 * `missingMonths` — місяці звіту, жоден день яких (у межах `from..to`) не покритий урахованим
 * періодом. Місяці, що починаються після `today`, позначаються лише з `warnFuture`
 * (налаштування `pnlWarnFuturePayroll`, типово ні): зарплату за майбутнє ще не розраховують, і
 * попередження там зазвичай шум.
 */
export function allocatePayrollByMonth(
  periods: readonly PnlPayrollPeriod[],
  months: readonly string[],
  from: string,
  to: string,
  today: string,
  warnFuture = false,
): { amounts: number[]; missingMonths: string[] } {
  const cents = months.map(() => 0);
  const covered = months.map(() => false);
  const rangeStart = dayUtc(from);
  const rangeEnd = dayUtc(to);
  const bounds = months.map(monthBounds);

  for (const p of periods) {
    if (p.deletedAt !== null || !PNL_PAYROLL_STATUSES.includes(p.status)) continue;
    const pStart = dayUtc(ymdOf(p.periodStart.getTime()));
    const pEnd = dayUtc(ymdOf(p.periodEnd.getTime()));
    if (pEnd < pStart) continue;
    const days = Math.round((pEnd - pStart) / DAY_MS) + 1;
    const totalCents = Math.round(p.accrued * 100);
    const cumulative = (k: number): number => Math.round((totalCents * k) / days);

    bounds.forEach((b, i) => {
      const segStart = Math.max(pStart, dayUtc(b.first), rangeStart);
      const segEnd = Math.min(pEnd, dayUtc(b.last), rangeEnd);
      if (segEnd < segStart) return;
      covered[i] = true;
      const before = Math.round((segStart - pStart) / DAY_MS);
      const upTo = Math.round((segEnd - pStart) / DAY_MS) + 1;
      cents[i] = (cents[i] ?? 0) + cumulative(upTo) - cumulative(before);
    });
  }

  const missingMonths = months.filter((m, i) => !covered[i] && (warnFuture || `${m}-01` <= today));
  return { amounts: cents.map(c => money(c / 100)), missingMonths };
}

export interface PnlCategory {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
}

export interface PnlCategoryRow {
  categoryId: string | null;
  parentId: string | null;
  label: string | null;
  depth: number;
  amounts: number[];
  total: number;
}

/**
 * BR-RPT-030 пп. 5–6 — рядки статей у порядку дерева (корінь, під ним його підстатті).
 * Сума рядка статті — її власні операції плюс усі підстатті (підсумок кореня). Статті без жодної
 * суми в періоді не показуються. Операції без статті (`null`) — окремим рядком наприкінці.
 * Стаття, якої немає в довіднику (не мала б траплятись: видалені теж передаються), — як корінь.
 */
export function buildCategoryRows(
  own: ReadonlyMap<string | null, readonly number[]>,
  categories: readonly PnlCategory[],
  monthCount: number,
): PnlCategoryRow[] {
  const byId = new Map(categories.map(c => [c.id, c]));
  const children = new Map<string | null, PnlCategory[]>();
  for (const c of categories) {
    const parent = c.parentId && byId.has(c.parentId) ? c.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(c);
    children.set(parent, list);
  }
  for (const id of own.keys()) {
    if (id !== null && !byId.has(id)) {
      const ghost: PnlCategory = { id, name: '', parentId: null, sortOrder: 0 };
      byId.set(id, ghost);
      children.set(null, [...(children.get(null) ?? []), ghost]);
    }
  }
  const sorted = (list: PnlCategory[]) =>
    [...list].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'uk'));

  const subtree = new Map<string, number[]>();
  const sumSubtree = (c: PnlCategory, guard: Set<string>): number[] => {
    const cached = subtree.get(c.id);
    if (cached) return cached;
    const acc = [...(own.get(c.id) ?? Array<number>(monthCount).fill(0))];
    if (!guard.has(c.id)) {
      guard.add(c.id);
      for (const ch of children.get(c.id) ?? []) {
        sumSubtree(ch, guard).forEach((v, i) => (acc[i] = (acc[i] ?? 0) + v));
      }
    }
    const rounded = acc.map(v => money(v));
    subtree.set(c.id, rounded);
    return rounded;
  };

  const rows: PnlCategoryRow[] = [];
  const walk = (list: PnlCategory[], depth: number, visited: Set<string>) => {
    for (const c of sorted(list)) {
      if (visited.has(c.id)) continue;
      visited.add(c.id);
      const amounts = sumSubtree(c, new Set());
      if (amounts.every(v => v === 0)) continue;
      rows.push({
        categoryId: c.id,
        parentId: c.parentId && byId.has(c.parentId) ? c.parentId : null,
        label: c.name || null,
        depth,
        amounts,
        total: sumMoney(amounts),
      });
      walk(children.get(c.id) ?? [], depth + 1, visited);
    }
  };
  walk(children.get(null) ?? [], 0, new Set());

  const none = own.get(null);
  if (none && none.some(v => v !== 0)) {
    const amounts = none.map(v => money(v));
    rows.push({
      categoryId: null,
      parentId: null,
      label: null,
      depth: 0,
      amounts,
      total: sumMoney(amounts),
    });
  }
  return rows;
}

/** Додає суму до місяця `month` у векторі статті (вектор створюється за потреби). */
export function addToMonth(
  acc: Map<string | null, number[]>,
  key: string | null,
  monthIndex: number,
  monthCount: number,
  amount: number,
): void {
  if (monthIndex < 0) return;
  const vec = acc.get(key) ?? Array<number>(monthCount).fill(0);
  vec[monthIndex] = (vec[monthIndex] ?? 0) + amount;
  acc.set(key, vec);
}

/** Σ рядків статей лише верхнього рівня (корені й «без статті») — підсумок розділу. */
export function sumRootRows(rows: readonly PnlCategoryRow[], monthCount: number): number[] {
  const acc = Array<number>(monthCount).fill(0);
  for (const r of rows)
    if (r.depth === 0) r.amounts.forEach((v, i) => (acc[i] = (acc[i] ?? 0) + v));
  return acc.map(v => money(v));
}
