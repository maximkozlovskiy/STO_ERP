import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** UUID v4 shape (case-insensitive). Спільний для валідації deep-link/route params. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Build an id→item Map from an array. O(N) one-time cost; O(1) lookups. */
export function toIdMap<T extends { id: string }>(arr: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const x of arr) m.set(x.id, x);
  return m;
}

/**
 * Тон-семантика балансу CP залежить від типу — CLIENT+SUPPLIER мають РІЗНУ шкалу
 * "проблема vs OK". Bug #606: до фіксу два UI-місця (список settlements + картка CP)
 * використовували дві різні захардкоджені евристики і показували ту саму цифру
 * контрастним кольором.
 *
 * Семантика (узгоджена з бековим BALANCE_SIGN):
 * - CLIENT: balance>0 = клієнт нам винен (дебіторська, треба стягнути → destructive);
 *   balance<0 = переплата клієнта (треба вирішити → warning).
 * - SUPPLIER: balance<0 = ми винні постачальнику (кредиторська → destructive);
 *   balance>0 = ми переплатили постачальнику (аномалія → warning).
 * - BOTH: обидва напрямки можливі — будь-який ненульовий = destructive (привертає увагу,
 *   бо тип-нейтрально інтерпретувати не можемо без деталізації по transactions).
 * - unknown/undefined type: fallback як BOTH (безпечно).
 */
export function settlementBalanceTone(
  balance: number,
  cpType: 'CLIENT' | 'SUPPLIER' | 'BOTH' | string | null | undefined,
): 'destructive' | 'warning' | 'success' | 'muted' {
  if (balance === 0) return 'muted';
  if (cpType === 'CLIENT') return balance > 0 ? 'destructive' : 'warning';
  if (cpType === 'SUPPLIER') return balance < 0 ? 'destructive' : 'warning';
  // BOTH або невідомий тип — будь-який ненульовий баланс потребує уваги.
  return 'destructive';
}

/** Tailwind-клас для тону settlementBalanceTone. Спрощує використання у JSX. */
export function settlementBalanceToneClass(tone: ReturnType<typeof settlementBalanceTone>): string {
  switch (tone) {
    case 'destructive':
      return 'text-destructive';
    case 'warning':
      return 'text-warning';
    case 'success':
      return 'text-success';
    case 'muted':
    default:
      return 'text-muted-foreground';
  }
}

/** Single-pass VAT + total computation for line/part rows. */
export function calcVatTotals(
  rows: { qty: number | undefined; price: number | undefined }[],
  vatRate: number,
): { total: number; vat: number } {
  let total = 0;
  let vat = 0;
  for (const r of rows) {
    if (r.qty != null && r.price != null) {
      const sum = r.qty * r.price;
      total += sum;
      if (vatRate > 0) vat += (sum * vatRate) / 100;
    }
  }
  return { total, vat };
}
