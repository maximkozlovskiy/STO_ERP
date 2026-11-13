// Тривалість і частини запису календаря у формі (BR-CAL-007, BR-CAL-016) — дзеркало серверних
// `manualSlotSegments` (`calendar.service.ts`) і `overflowEnd` (`work-hours.ts`). Значення —
// київський настінний час «YYYY-MM-DDTHH:mm» (як у DateTimePickerInput). Запис, що починається до
// закриття РОБОЧОГО дня філії підйомника, — «початок + тривалість», а все, що виходить за закриття,
// переходить на наступні робочі дні від відкриття (скільки завгодно днів, вихідні пропускаються);
// сервер ділить його на ті самі частини. Запис, що починається у вихідний чи о закритті й пізніше,
// — один запис «початок + тривалість» (№86).

import { DEFAULT_WORK_DAYS } from '@sto/shared';
import {
  calcEndFromHours,
  calcPlannedHours,
  type WorkHoursWindow,
} from '@/components/ui/work-order/planned-dates';

/** Частина запису: початок і кінець, київський час «YYYY-MM-DDTHH:mm». */
export interface LocalSpan {
  start: string;
  end: string;
}

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const DT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** «YYYY-MM-DDTHH:mm» → хвилина від епохи (UTC-лічильник, без часового поясу — лише арифметика). */
function toMinute(value: string): number | null {
  const m = DT_RE.exec(value?.slice(0, 16) ?? '');
  if (!m) return null;
  const h = Number(m[4]);
  const min = Number(m[5]);
  if (h > 23 || min > 59) return null;
  const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS;
  return Number.isFinite(day) ? day * 1440 + h * 60 + min : null;
}

function fromMinute(total: number): string {
  const day = Math.floor(total / 1440);
  const minute = total - day * 1440;
  const d = new Date(day * DAY_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
    Math.floor(minute / 60),
  )}:${pad(minute % 60)}`;
}

function isWorkDay(day: number, wh: WorkHoursWindow): boolean {
  const days = wh.workDays && wh.workDays.length > 0 ? wh.workDays : DEFAULT_WORK_DAYS;
  return days.includes(new Date(day * DAY_MS).getUTCDay() || 7);
}

/** Закриття дня початку (хвилина від епохи), якщо сервер ділить запис із цього початку; інакше `null`. */
function splitClose(s: number, wh: WorkHoursWindow): number | null {
  if (wh.endHour <= wh.startHour) return null;
  const day = Math.floor(s / 1440);
  const close = day * 1440 + wh.endHour * 60;
  return isWorkDay(day, wh) && s < close ? close : null;
}

/**
 * Чи ділить сервер запис з цього початку на дні: початок — робочий день філії і до закриття
 * (BR-CAL-007). Інакше запис — один, із запитаним часом.
 */
export function startsInWorkTime(start: string, wh: WorkHoursWindow): boolean {
  const s = toMinute(start);
  return s !== null && splitClose(s, wh) !== null;
}

/** Залишок за закриттям (хвилини) — від відкриття наступних робочих днів, як `overflowEnd`. */
function carryFromClose(close: number, minutes: number, wh: WorkHoursWindow): string {
  return calcEndFromHours(fromMinute(close), minutes / 60, wh);
}

/**
 * Кінець запису за початком і нормогодинами — «початок + тривалість»; з робочого часу частина за
 * закриттям переходить на наступні робочі дні (BR-CAL-007, №72). '' — невалідний ввід.
 */
export function slotEndFromHours(start: string, hours: number, wh: WorkHoursWindow): string {
  const s = toMinute(start);
  if (s === null || !Number.isFinite(hours) || hours <= 0) return '';
  const total = s + Math.round(hours * 60);
  const close = splitClose(s, wh);
  if (close === null || total <= close) return fromMinute(total);
  return carryFromClose(close, total - close, wh) || fromMinute(total);
}

/**
 * Нормогодини між початком і кінцем запису — зворотне до `slotEndFromHours`: кінець того ж дня —
 * тривалість (сервер читає його як «початок + тривалість»); кінець іншого дня з робочого початку —
 * години першого дня до закриття плюс робочі години після нього. '' — кінець не пізніше початку.
 */
export function slotHoursBetween(start: string, end: string, wh: WorkHoursWindow): string {
  const s = toMinute(start);
  const e = toMinute(end);
  if (s === null || e === null || e <= s) return '';
  const close = splitClose(s, wh);
  const sameDay = Math.floor(e / 1440) === Math.floor(s / 1440);
  let minutes = e - s;
  if (close !== null && !sameDay) {
    const after = Number(calcPlannedHours(fromMinute(close), end, wh) || '0');
    minutes = close - s + Math.round(after * 60);
  }
  return String(Math.round((minutes / 60) * 100) / 100);
}

/**
 * Кінець багатоденного ланцюжка, перенесеного на новий початок (BR-CAL-020, перетягування в «Дні»):
 * ті самі нормогодини, що між старими межами `start`..`end` за годинами філії старого підйомника
 * (`from`), від нового початку за годинами філії нового (`to`) — як форма рахує кінець за
 * нормогодинами. '' — межі невалідні.
 */
export function shiftedChainEnd(
  start: string,
  end: string,
  newStart: string,
  from: WorkHoursWindow,
  to: WorkHoursWindow,
): string {
  const hours = Number(slotHoursBetween(start, end, from));
  return hours > 0 ? slotEndFromHours(newStart, hours, to) : '';
}

/**
 * Справжній кінець запису (як серверний `overflowEnd`): кінець на ТОМУ Ж дні після закриття
 * робочого дня (ручний вибір кінця 20:00) — залишок після закриття переходить на наступні робочі
 * дні; інакше — як є.
 */
export function slotRealEnd(start: string, end: string, wh: WorkHoursWindow): string {
  const s = toMinute(start);
  const e = toMinute(end);
  if (s === null || e === null || e <= s) return end;
  const close = splitClose(s, wh);
  if (close === null || e <= close || Math.floor(e / 1440) !== Math.floor(s / 1440)) return end;
  return carryFromClose(close, e - close, wh) || end;
}

/**
 * Частини, на які сервер поділить новий запис [start, end): з робочого часу — перша від запитаного
 * початку до закриття, далі по частині на кожен робочий день у робочих годинах; інакше — одна.
 */
export function slotParts(start: string, rawEnd: string, wh: WorkHoursWindow): LocalSpan[] {
  const end = slotRealEnd(start, rawEnd, wh);
  const s = toMinute(start);
  const e = toMinute(end);
  if (s === null || e === null || e <= s) return [];
  const firstClose = splitClose(s, wh);
  if (firstClose === null || e <= firstClose) return [{ start, end }];
  const firstDay = Math.floor(s / 1440);
  const parts: LocalSpan[] = [{ start, end: fromMinute(firstClose) }];
  const lastDay = Math.floor((e - 1) / 1440);
  for (let day = firstDay + 1; day <= lastDay && day - firstDay < 3660; day++) {
    if (!isWorkDay(day, wh)) continue;
    const from = day * 1440 + wh.startHour * 60;
    const to = Math.min(e, day * 1440 + wh.endHour * 60);
    if (to > from) parts.push({ start: fromMinute(from), end: fromMinute(to) });
  }
  return parts;
}
