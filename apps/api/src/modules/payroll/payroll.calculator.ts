import { money, ZERO_MONEY, type Money } from '../../common/utils/money';

/**
 * Розрахунок нарахування ЗП одному співробітнику за rateScheme та виробітком за період.
 * Чиста функція — юніт-тестується ізольовано. Гроші квантуються money() (копійка,
 * half-away-from-zero) і повертаються брендованим типом Money — див. MP-B13.
 *
 * Виробіток (base) береться з ЗАВЕРШЕНИХ робіт періоду (completedAt + статус наряду):
 *  - baseAmount = Σ WorkOrderLine.amount (сума виконаних робіт)
 *  - normoHours = Σ WorkOrderLine.normoHours
 *
 * Режими rateScheme:
 *  - percent_normo    { percent }              → percent% від baseAmount
 *  - per_normo_hour   { ratePerHour }          → ratePerHour × normoHours
 *  - fixed_plus_bonus { fixedMonthly, bonusPercent } → fixedMonthly × частка періоду в місяці
 *                                                      + bonusPercent% від baseAmount
 */
export interface PayrollWork {
  baseAmount: number;
  normoHours: number;
}

// Тип rateScheme дзеркалить employees.dto Zod (discriminated union). Тут — runtime-safe парсинг
// (rateScheme у БД — Json, тож валідуємо форму перед розрахунком).
export type ParsedRateScheme =
  | { type: 'percent_normo'; params: { percent: number } }
  | { type: 'per_normo_hour'; params: { ratePerHour: number } }
  | { type: 'fixed_plus_bonus'; params: { fixedMonthly: number; bonusPercent: number } };

/** Безпечно розбирає rateScheme з Json. Повертає null, якщо форма невалідна. */
export function parseRateScheme(raw: unknown): ParsedRateScheme | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { type?: unknown; params?: unknown };
  const p = (r.params ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);

  if (r.type === 'percent_normo') {
    const percent = num(p.percent);
    return percent === null ? null : { type: 'percent_normo', params: { percent } };
  }
  if (r.type === 'per_normo_hour') {
    const ratePerHour = num(p.ratePerHour);
    return ratePerHour === null ? null : { type: 'per_normo_hour', params: { ratePerHour } };
  }
  if (r.type === 'fixed_plus_bonus') {
    const fixedMonthly = num(p.fixedMonthly);
    const bonusPercent = num(p.bonusPercent);
    return fixedMonthly === null || bonusPercent === null
      ? null
      : { type: 'fixed_plus_bonus', params: { fixedMonthly, bonusPercent } };
  }
  return null;
}

/**
 * Частка місячного окладу, що припадає на період (BR-PAYR-006): для кожного календарного місяця,
 * який зачіпає період, — `днів періоду в цьому місяці / днів у місяці`; частки складаються.
 * Дати — календарні `YYYY-MM-DD`, обидві включно. Повний місяць → 1; 01–07 вересня → 7/30;
 * 25.09–05.10 → 6/30 + 5/31. До 2026-10-08 оклад додавався повністю в КОЖНУ відомість, тож
 * чотири тижневі відомості за місяць давали чотири оклади.
 * Невалідні дати або початок пізніше кінця → 0 (сервіс відхиляє такий період раніше).
 */
export function monthShareOfPeriod(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return 0;
  const DAY_MS = 86_400_000;
  let share = 0;
  let cursor = new Date(start);
  while (cursor.getTime() <= end) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const monthEnd = Date.UTC(year, month, daysInMonth);
    const lastDay = Math.min(monthEnd, end);
    const days = Math.round((lastDay - cursor.getTime()) / DAY_MS) + 1;
    share += days / daysInMonth;
    cursor = new Date(Date.UTC(year, month + 1, 1));
  }
  return share;
}

/**
 * Обчислює суму нарахування (грн) за схемою і виробітком. Невалідна схема → 0.
 * `monthShare` — частка місяця, яку покриває період (`monthShareOfPeriod`); впливає лише на
 * фіксовану частину `fixed_plus_bonus`. Параметр обов'язковий навмисно: значення за
 * замовчуванням повернуло б «повний оклад у кожну відомість».
 */
export function computeAccrued(
  scheme: ParsedRateScheme | null,
  work: PayrollWork,
  monthShare: number,
): Money {
  if (!scheme) return ZERO_MONEY;
  const base = Math.max(0, work.baseAmount || 0);
  const hours = Math.max(0, work.normoHours || 0);
  switch (scheme.type) {
    case 'percent_normo':
      return money((base * scheme.params.percent) / 100);
    case 'per_normo_hour':
      return money(hours * scheme.params.ratePerHour);
    case 'fixed_plus_bonus':
      return money(
        scheme.params.fixedMonthly * Math.max(0, monthShare) +
          (base * scheme.params.bonusPercent) / 100,
      );
  }
}

/** Знімок параметрів схеми в рядку відомості (BR-PAYR-016) — те саме, що `ParsedRateScheme.params`. */
export type RateParams = ParsedRateScheme['params'];

/**
 * Читає знімок `PayrollLine.rateParams` (Json) через ту саму перевірку, що й живу схему: невідомий
 * тип рядка, неповні чи нечислові параметри → null (рядок поводиться як «без знімка»).
 */
export function parseRateParams(rateSchemeType: string, raw: unknown): ParsedRateScheme | null {
  if (raw === null || raw === undefined) return null;
  return parseRateScheme({ type: rateSchemeType, params: raw });
}

/** Ставка, виведена з підсумку рядка без знімка (BR-PAYR-016): 2 знаки, база 0 → null. */
export function deriveRateParams(
  rateSchemeType: string,
  line: { accruedAmount: number; baseAmount: number; normoHours: number },
): RateParams | null {
  const round2 = (v: number) => Math.round(v * 100) / 100;
  if (rateSchemeType === 'percent_normo') {
    return line.baseAmount > 0
      ? { percent: round2((line.accruedAmount / line.baseAmount) * 100) }
      : null;
  }
  if (rateSchemeType === 'per_normo_hour') {
    return line.normoHours > 0
      ? { ratePerHour: round2(line.accruedAmount / line.normoHours) }
      : null;
  }
  return null;
}

/** Оклад за період схеми «оклад + бонус» — та сама частка місяця, що в `computeAccrued`. */
export function fixedPartOfPeriod(fixedMonthly: number, monthShare: number): Money {
  return money(fixedMonthly * Math.max(0, monthShare));
}

/** Результат розкладу нарахування рядка по нарядах (BR-PAYR-016). */
export interface AccruedAllocation {
  /** Оклад за період («оклад + бонус») — окремий рядок розшифровки; для інших схем null. */
  fixedPart: Money | null;
  /** Нараховано по кожному наряду, у порядку вхідних нарядів; null — розклад невідомий. */
  amounts: Money[] | null;
}

/**
 * BR-PAYR-016: ділить змінну частину нарахування рядка між нарядами.
 *  - `percent_normo` і невідома схема — уся сума пропорційно сумі робіт наряду;
 *  - `per_normo_hour` — уся сума пропорційно нормо-годинам наряду;
 *  - `fixed_plus_bonus` — спершу оклад за період (`fixedMonthly × monthShareOfPeriod`) окремо,
 *    залишок (бонус) — пропорційно сумі робіт; без знімка параметрів оклад невідомий → розкладу
 *    немає (`amounts: null`).
 * Копійки — методом найбільшого залишку: Σ amounts = змінна частина до копійки. Рівні залишки
 * отримують копійку в порядку нарядів. Від'ємна база наряду вважається нулем (як у
 * `computeAccrued`); якщо бази немає взагалі, а сума є (розбіжні дані), — порівну.
 */
export function allocateAccruedByWorkOrder(input: {
  rateSchemeType: string;
  accruedAmount: number;
  scheme: ParsedRateScheme | null;
  periodStart: string;
  periodEnd: string;
  workOrders: readonly PayrollWork[];
}): AccruedAllocation {
  const { rateSchemeType, scheme, workOrders } = input;
  let fixedPart: Money | null = null;
  if (rateSchemeType === 'fixed_plus_bonus') {
    if (scheme?.type !== 'fixed_plus_bonus') return { fixedPart: null, amounts: null };
    fixedPart = fixedPartOfPeriod(
      scheme.params.fixedMonthly,
      monthShareOfPeriod(input.periodStart, input.periodEnd),
    );
  }
  const variable = Math.max(0, input.accruedAmount - (fixedPart ?? 0));
  const weights = workOrders.map(w =>
    Math.max(0, (rateSchemeType === 'per_normo_hour' ? w.normoHours : w.baseAmount) || 0),
  );
  return { fixedPart, amounts: splitByLargestRemainder(variable, weights) };
}

/** Ділить суму на частки за вагами з точністю до копійки (метод найбільшого залишку). */
function splitByLargestRemainder(total: number, weights: readonly number[]): Money[] {
  if (weights.length === 0) return [];
  const totalCents = Math.round(total * 100);
  const weightSum = weights.reduce((s, w) => s + w, 0);
  const effective = weightSum > 0 ? weights : weights.map(() => 1);
  const effectiveSum = weightSum > 0 ? weightSum : weights.length;
  const raw = effective.map(w => (totalCents * w) / effectiveSum);
  const cents = raw.map(Math.floor);
  let rest = totalCents - cents.reduce((s, c) => s + c, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    cents[i] += 1;
    rest -= 1;
  }
  return cents.map(c => money(c / 100));
}
