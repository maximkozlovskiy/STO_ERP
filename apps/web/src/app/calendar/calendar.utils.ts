// ─── Shared Calendar Utilities ───────────────────────────────────────────────

import type { CounterpartyOption } from './calendar.types';

export const KYIV_TZ = 'Europe/Kyiv';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const HOURS = Array.from({ length: 12 }, (_, i) => i + 8);
export const TOTAL_HOURS = HOURS.length;
export const SIDEBAR_W = 160;
export const WINDOW_START = HOURS[0]!;
export const WINDOW_END = HOURS[HOURS.length - 1]! + 1;

// Time picker: exactly the working hours window (08–19)
export const PICK_HOURS = HOURS; // [8, 9, ..., 19]
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

export function decimalHoursToHHMM(h: number): string {
  const totalMin = Math.min(24 * 60, Math.max(0, Math.round(h * 60)));
  return `${pad(Math.floor(totalMin / 60))}:${pad(totalMin % 60)}`;
}

export function decimalHoursToISO(date: string, h: number): string {
  return new Date(`${date}T${decimalHoursToHHMM(h)}:00`).toISOString();
}

export function snapTo15(h: number): number {
  return Math.round(h * 4) / 4;
}

export function pxToHours(px: number, timelineW: number): number {
  return (px / timelineW) * TOTAL_HOURS;
}

/** Parse "HH:mm" → { h, m } snapped to nearest 15min */
export function parseHHMM(s: string): { h: number; m: number } {
  const [hh, mm] = s.split(':').map(Number);
  const snapped = Math.round((mm ?? 0) / 15) * 15;
  return { h: hh ?? HOURS[0]!, m: snapped >= 60 ? 0 : snapped };
}

export function buildHHMM(h: number, m: number): string {
  return `${pad(h)}:${pad(m)}`;
}

export function displayCounterparty(cp: CounterpartyOption): string {
  return cp.companyName ?? ([cp.lastName, cp.firstName].filter(Boolean).join(' ') || '(без імені)');
}

export function formatKyivDate(ds: string): string {
  if (!ds) return '';
  return new Date(ds).toLocaleDateString('uk-UA', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: KYIV_TZ,
  });
}
