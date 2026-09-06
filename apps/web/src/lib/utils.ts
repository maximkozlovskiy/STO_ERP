import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** UUID v4 shape (case-insensitive). Спільний для валідації deep-link/route params. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SECURITY: екранування клітинки CSV від formula-injection (CWE-1236).
 *
 * Excel/LibreOffice виконують формулу у клітинці, що починається з `= + - @` (або TAB/CR).
 * Користувацький вільний текст (примітки, назви контрагентів/товарів) може містити
 * `=HYPERLINK(...)` / `=cmd|...` → при відкритті експорту виконується на ПК співробітника.
 * Нейтралізуємо: (1) префікс `'` перед небезпечним лідером; (2) стандартне CSV-квотування
 * (обгортка в "..." з подвоєнням лапок) якщо є роздільник/лапки/перенос рядка.
 *
 * Застосовувати до КОЖНОЇ текстової клітинки при побудові CSV/XLSX з даних БД.
 */
export function escapeCsvCell(value: unknown, delimiter = ';'): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // Formula-injection guard: небезпечні лідери → префікс апострофа (нейтралізує формулу).
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  // CSV-квотування, якщо містить роздільник, лапки або перенос.
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
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

/**
 * Округлення грошей до 2 знаків (копійки), half-away-from-zero (бухгалтерське).
 * Дзеркалить backend `apps/api/src/common/utils/math.ts:roundMoney` — обидві сторони
 * мають квантувати ІДЕНТИЧНО, інакше preview-сума у модалці розходиться з тим, що
 * порахує бекенд (WO-H2 / FIN-H1: `300.3 * 0.2 = 60.059999…`, а `Σ(рядки)` дрейфує на копійку).
 * `+1e-9` нейтралізує представлення на кшталт 1.005 → 1.00 замість 1.01.
 */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * 100 + 1e-9)) / 100;
}

/**
 * Single-pass VAT + total computation for line/part rows.
 *
 * ЄДИНИЙ споживач — CreateWorkOrderModal (preview у tfoot). Тому квантування МУСИТЬ
 * дзеркалити backend `work-orders.service.ts:recalcTotals`, а не `calcLineVat`:
 *   • total  = Σ(roundMoney(qty × price))  — per-line rounded amounts складаються
 *              (backend `l.amount` вже округлений per-line у addLine/addPart → totalLabor).
 *   • vat    = roundMoney(base × vatRate/100)  — ПДВ рахується ОДИН раз на агрегованій
 *              (вже округленій) базі, EXCLUSIVE-режим. НЕ per-line: recalcTotals робить
 *              `(totalBase * vatRate)/100` над сумою, тож per-line-квантування ПДВ дало б
 *              preview на копійку більше за збережений amount (напр. 3×2.525@20%: per-line
 *              Σ=1.53, aggregate=1.52 → preview≠saved). WO-H2 / FIN-H1.
 * `base` — вже roundMoney(total), тож повторний roundMoney лишає його стабільним.
 */
export function calcVatTotals(
  rows: { qty: number | undefined; price: number | undefined }[],
  vatRate: number,
): { total: number; vat: number } {
  let total = 0;
  for (const r of rows) {
    if (r.qty != null && r.price != null) {
      total += roundMoney(r.qty * r.price);
    }
  }
  const base = roundMoney(total);
  const vat = vatRate > 0 ? roundMoney((base * vatRate) / 100) : 0;
  return { total: base, vat };
}
