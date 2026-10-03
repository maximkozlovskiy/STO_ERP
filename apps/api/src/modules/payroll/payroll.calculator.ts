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
 *  - fixed_plus_bonus { fixedMonthly, bonusPercent } → fixedMonthly + bonusPercent% від baseAmount
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

/** Обчислює суму нарахування (грн) за схемою і виробітком. Невалідна схема → 0. */
export function computeAccrued(scheme: ParsedRateScheme | null, work: PayrollWork): Money {
  if (!scheme) return ZERO_MONEY;
  const base = Math.max(0, work.baseAmount || 0);
  const hours = Math.max(0, work.normoHours || 0);
  switch (scheme.type) {
    case 'percent_normo':
      return money((base * scheme.params.percent) / 100);
    case 'per_normo_hour':
      return money(hours * scheme.params.ratePerHour);
    case 'fixed_plus_bonus':
      return money(scheme.params.fixedMonthly + (base * scheme.params.bonusPercent) / 100);
  }
}
