import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Bug #139: відображення імені контрагента — спільна логіка для combobox primary,
 * displayValue і список item'ів. Прибирає dead `?? ''` після `.join(' ')` і додає
 * fallback на `'(без імені)'` коли companyName і firstName/lastName всі null/empty.
 *
 * @example
 * displayCounterpartyName({ companyName: 'ТОВ Альфа', ... })          → 'ТОВ Альфа'
 * displayCounterpartyName({ companyName: null, firstName: 'Іван', lastName: 'Петренко' }) → 'Петренко Іван'
 * displayCounterpartyName({ companyName: null, firstName: null, lastName: null })          → '(без імені)'
 */
export function displayCounterpartyName(cp: {
  companyName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): string {
  if (cp.companyName && cp.companyName.trim()) return cp.companyName.trim();
  const personName = [cp.lastName, cp.firstName].filter(Boolean).join(' ').trim();
  return personName || '(без імені)';
}

const MS_PER_DAY = 86_400_000;

/**
 * Кількість повних днів від `nowMs` до дати `date` (ceil).
 * Від'ємний результат → дата у минулому (прострочено).
 * `null` коли дата відсутня або `nowMs` ще не ініціалізований (SSR-safe: 0).
 *
 * Спільна логіка для всіх "expired/soon" бейджів (страховка, техогляд, ТО).
 * Винесено з 4 дубльованих inline-IIFE у vehicles/[id] та crm/[id].
 *
 * @example
 * daysUntil('2026-06-10', Date.parse('2026-05-28')) → 13
 * daysUntil('2026-05-01', Date.parse('2026-05-28')) → -27 (прострочено)
 */
export function daysUntil(date: string | Date | null | undefined, nowMs: number): number | null {
  if (!date || !nowMs) return null;
  const target = typeof date === 'string' ? new Date(date) : date;
  const t = target.getTime();
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - nowMs) / MS_PER_DAY);
}
