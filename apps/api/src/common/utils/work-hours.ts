import { DEFAULT_WORK_HOURS } from '@sto/shared';
import { kyivOffsetMs, kyivYmd } from './kyiv-date';

/**
 * Робочі години філії — одне джерело для календаря (розбиття запису на дні, BR-CAL-007),
 * `GET /settings/work-hours` (сітка календаря, пікер планових дат) і перевірки планових дат
 * наряду (BR-WO-019).
 *
 * Типові години, коли в філії немає `BranchSettings` або вони зіпсовані, — `DEFAULT_WORK_HOURS`
 * з `@sto/shared` (09:00–18:00, як `@default` колонок `workStartTime`/`workEndTime`): майстер
 * першого запуску створює філії рядок налаштувань саме з цими годинами, тож філія без рядка
 * поводиться так само, як щойно створена. До 2026-10-16 календар мав власний дефолт 08:00–20:00,
 * а `GET /settings/work-hours` — 09:00–18:00: сітка показувала кінець дня о 18:00, а сервер ділив
 * запис на дні о 20:00.
 */
export interface WorkHours {
  /** Перша робоча година київської доби (включно), 0–23. */
  readonly startHour: number;
  /** Година закриття (кінець робочого дня), 1–24; більша за `startHour`. */
  readonly endHour: number;
}

const DAY_MS = 86_400_000;
/** Запобіжник `splitByWorkHours` від нескінченного циклу: не більше року днів. */
const MAX_SPLIT_DAYS = 366;

/** "HH:mm" → хвилина доби 0..1439 (хвилин може не бути: "9:" — 09:00); невалідне → `null`. */
function parseWorkMinute(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})?/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : null;
}

/** "HH:mm" → ціла година 0..23; невалідне значення → `fallback`. */
function parseWorkHour(value: string | null | undefined, fallback: number): number {
  const minute = parseWorkMinute(value);
  return minute === null ? fallback : Math.floor(minute / 60);
}

/**
 * Робочі години з рядка `BranchSettings`. Немає рядка, невалідний час або кінець не пізніше
 * початку (дані до валідації DTO) → типові години цілком, а не наполовину.
 */
export function workHoursOf(
  row: { workStartTime?: string | null; workEndTime?: string | null } | null | undefined,
): WorkHours {
  if (!row) return DEFAULT_WORK_HOURS;
  const startHour = parseWorkHour(row.workStartTime, DEFAULT_WORK_HOURS.startHour);
  const endHour = parseWorkHour(row.workEndTime, DEFAULT_WORK_HOURS.endHour);
  return endHour > startHour ? { startHour, endHour } : DEFAULT_WORK_HOURS;
}

/** Типові робочі дні — пн–пт (ISO: 1 = пн … 7 = нд), як `@default` колонки `workDays`. */
export const DEFAULT_WORK_DAYS: readonly number[] = Object.freeze([1, 2, 3, 4, 5]);

/**
 * Робочі дні тижня з рядка `BranchSettings` (ISO: 1 = пн … 7 = нд — так їх пише вкладка
 * «Робочі дні» і читає онлайн-запис, BR-CAL-004). Немає рядка або `workDays` не масив → пн–пт.
 */
export function workDaysOf(row: { workDays?: unknown } | null | undefined): readonly number[] {
  const raw = row?.workDays;
  return Array.isArray(raw)
    ? raw.filter((d): d is number => typeof d === 'number' && Number.isInteger(d))
    : DEFAULT_WORK_DAYS;
}

/**
 * Тривалість робочого дня філії в годинах — з хвилинами (08:30–17:00 → 8,5), на відміну від
 * `workHoursOf`, що дає цілі години сітки календаря. Розбір і типові значення ті самі: невалідний
 * час — типовий, кінець не пізніше початку — типовий день 09–18 цілком.
 */
export function workDayHoursOf(
  row: { workStartTime?: string | null; workEndTime?: string | null } | null | undefined,
): number {
  const defStart = DEFAULT_WORK_HOURS.startHour * 60;
  const defEnd = DEFAULT_WORK_HOURS.endHour * 60;
  const start = parseWorkMinute(row?.workStartTime) ?? defStart;
  const end = parseWorkMinute(row?.workEndTime) ?? defEnd;
  return (end > start ? end - start : defEnd - defStart) / 60;
}

/**
 * Робочий час філії за календарні дні `fromYmd..toYmd` (обидва включно; київські дати
 * `YYYY-MM-DD`) у годинах: робочий день — `workDayHoursOf`, вихідний — 0 (BR-RPT-033).
 * День тижня береться з самої дати (полудень UTC), тож переведення годинника не впливає.
 */
export function workCapacityHours(
  fromYmd: string,
  toYmd: string,
  row:
    | { workStartTime?: string | null; workEndTime?: string | null; workDays?: unknown }
    | null
    | undefined,
): number {
  const days = new Set(workDaysOf(row));
  const perDay = workDayHoursOf(row);
  const last = Date.parse(`${toYmd}T12:00:00Z`);
  let total = 0;
  for (let t = Date.parse(`${fromYmd}T12:00:00Z`); t <= last; t += DAY_MS) {
    const isoDay = new Date(t).getUTCDay() || 7;
    if (days.has(isoDay)) total += perDay;
  }
  return Math.round(total * 100) / 100;
}

/** Хвилина київської доби миті (дробова, з секундами), DST-aware. */
export function kyivMinuteOfDay(d: Date): number {
  const local = d.getTime() + kyivOffsetMs(d);
  return (((local % DAY_MS) + DAY_MS) % DAY_MS) / 60_000;
}

/**
 * Мить UTC для години `hour` (0..24) київського дня `ymd`. Зсув береться на полудень дня:
 * робочі години не потрапляють на нічне переведення годинника (03:00/04:00), тож години дня
 * однакові з календарем.
 */
export function kyivHourOnDay(ymd: string, hour: number): Date {
  const noon = new Date(`${ymd}T12:00:00Z`);
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + hour * 3_600_000 - kyivOffsetMs(noon));
}

/** Наступний київський день після `ymd`. */
function nextKyivDay(ymd: string): string {
  return kyivYmd(new Date(kyivHourOnDay(ymd, 12).getTime() + DAY_MS));
}

export interface TimeSegment {
  startAt: Date;
  endAt: Date;
}

/**
 * Проміжок [start, end) у межах робочих годин: по відрізку на кожен київський день, де проміжок
 * перетинає робоче вікно `startHour..endHour`. Наряд з 10:00 сьогодні до 12:00 завтра (вікно 9–18)
 * дає 10:00–18:00 і 09:00–12:00 — запис календаря займає підйомник лише в робочий час (BR-WO-020).
 * Дні без перетину пропускаються.
 */
export function splitByWorkHours(start: Date, end: Date, hours: WorkHours): TimeSegment[] {
  const out: TimeSegment[] = [];
  if (!(end.getTime() > start.getTime())) return out;
  const lastDay = kyivYmd(end);
  let day = kyivYmd(start);
  for (let i = 0; i < MAX_SPLIT_DAYS; i++) {
    const open = kyivHourOnDay(day, hours.startHour);
    const close = kyivHourOnDay(day, hours.endHour);
    const segStart = Math.max(start.getTime(), open.getTime());
    const segEnd = Math.min(end.getTime(), close.getTime());
    if (segEnd > segStart) out.push({ startAt: new Date(segStart), endAt: new Date(segEnd) });
    if (day === lastDay) break;
    day = nextKyivDay(day);
  }
  return out;
}
