// ─── Shared Calendar Utilities ───────────────────────────────────────────────

import { kyivDateTimeToISO } from '@/lib/format';
import { displayCounterpartyName } from '@/lib/utils';
import type { CounterpartyOption } from './calendar.types';

export const KYIV_TZ = 'Europe/Kyiv';
// Re-export спільного UUID_RE з lib/utils — єдине джерело правди
// (споживачі calendar.utils, напр. CalendarSlotModal, працюють без змін).
export { UUID_RE } from '@/lib/utils';
export const SIDEBAR_W = 160;

// Time picker: 15-min step within working hours window.
export const PICK_MINUTES = [0, 15, 30, 45];

// Max days a custom stats range may span
export const STATS_MAX_DAYS = 92; // ≈ one quarter

// Module-level cached Intl formatters
const DATE_FMT = new Intl.DateTimeFormat('sv-SE', { timeZone: KYIV_TZ });
const KYIV_HM_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: KYIV_TZ,
  hour: 'numeric',
  minute: 'numeric',
  hour12: false,
});
export const KYIV_HOUR_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: KYIV_TZ,
  hour: 'numeric',
  hour12: false,
});
const TIME_FMT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: KYIV_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

// `DD.MM.YYYY` у часовому поясі Києва — для рендеру дат у списках/пікерах календаря.
const KYIV_DMY_FMT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: KYIV_TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

// Місяць+рік (наприклад "травень 2026") у часовому поясі Києва — для header'ів місячного календаря
// та CalendarStatsTab. Раніше викликався inline `.toLocaleDateString` що конструював форматер на кожен render.
const KYIV_MONTH_YEAR_FMT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: KYIV_TZ,
  month: 'long',
  year: 'numeric',
});

// Повний формат "weekday, DD month YYYY" у Kyiv TZ — для tab-headers у статистиці календаря.
const KYIV_FULL_DATE_FMT = new Intl.DateTimeFormat('uk-UA', {
  timeZone: KYIV_TZ,
  weekday: 'long',
  day: '2-digit',
  month: 'long',
  year: 'numeric',
});

export function pad(n: number) {
  return String(n).padStart(2, '0');
}

export function toDateString(d: Date) {
  return DATE_FMT.format(d);
}

export function kyivHours(iso: string): number {
  const parts = KYIV_HM_FMT.formatToParts(new Date(iso));
  const h = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
  const m = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  return h + m / 60;
}

export function fmtTime(iso: string) {
  return TIME_FMT.format(new Date(iso));
}

/**
 * Дата у форматі `DD.MM.YYYY` у часовому поясі Києва. Викликається у `.map()`
 * списків пошуку слотів/нарядів, тому переконайся що формат тільки .format(), не конструктор.
 */
export function fmtKyivDate(iso: string) {
  return KYIV_DMY_FMT.format(new Date(iso));
}

export function decimalHoursToHHMM(h: number): string {
  const totalMin = Math.min(24 * 60, Math.max(0, Math.round(h * 60)));
  return `${pad(Math.floor(totalMin / 60))}:${pad(totalMin % 60)}`;
}

export function decimalHoursToISO(date: string, h: number): string {
  // парсинг без TZ → local-time у браузерах поза Kyiv.
  // Використовуємо Kyiv → UTC конверсію.
  return kyivDateTimeToISO(date, decimalHoursToHHMM(h));
}

export function snapTo15(h: number): number {
  return Math.round(h * 4) / 4;
}

/** Parse "HH:mm" → { h, m } snapped to nearest 15min */
export function parseHHMM(s: string): { h: number; m: number } {
  const [hh, mm] = s.split(':').map(Number);
  const snapped = Math.round((mm ?? 0) / 15) * 15;
  // fallback 9 (BranchSettings Prisma default workStartTime='09:00').
  return { h: hh ?? 9, m: snapped >= 60 ? 0 : snapped };
}

export function buildHHMM(h: number, m: number): string {
  return `${pad(h)}:${pad(m)}`;
}

// Thin proxy до спільного `displayCounterpartyName` з lib/utils — робастніше:
// (1) `.trim()` на companyName відкидає пробіли/пусті рядки (raw `??` пропускав "");
// (2) `Петренко Іван` порядок (LAST FIRST) узгоджений з рештою UI.
// Wrapper збережений для збереження існуючих імпортів у CalendarSlotModal без масової правки.
export function displayCounterparty(cp: CounterpartyOption): string {
  return displayCounterpartyName(cp);
}

export function formatKyivDate(ds: string): string {
  if (!ds) return '';
  return KYIV_FULL_DATE_FMT.format(new Date(ds));
}

/**
 * "Місяць рік" (наприклад "травень 2026") у часовому поясі Києва.
 * Викликається у month-view header'ах календаря — використовує module-level singleton.
 */
export function fmtKyivMonthYear(date: string): string {
  if (!date) return '';
  // Полудень в UTC дає коректний місяць у Kyiv TZ незалежно від DST переходів.
  return KYIV_MONTH_YEAR_FMT.format(new Date(date + 'T12:00:00'));
}
