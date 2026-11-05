// Планові дати наряду в робочих годинах філії (BR-WO-019): автокінець за нормогодинами і
// нормогодини між початком і завершенням. Значення — київський настінний час
// «YYYY-MM-DDTHH:mm» (як у DateTimePickerInput). Ніч і години поза вікном не рахуються: наряд
// з 16:00 на 3 год при вікні 9–18 закінчується завтра об 10:00 — так само сервер ділить запис
// календаря наряду на дні (BR-WO-020). Вихідні філії (`workDays`) теж не рахуються: при пн–сб
// субота 17:00 + 3 год — понеділок 11:00 (BR-WO-019, BR-CAL-016).

import { DEFAULT_WORK_HOURS } from '@sto/shared';

export interface WorkHoursWindow {
  startHour: number;
  endHour: number;
  /**
   * Робочі дні філії, ISO (1 = пн … 7 = нд). Немає чи порожній — кожен день робочий (як на
   * сервері для філії без налаштувань).
   */
  workDays?: readonly number[];
}

/**
 * Типові години — ті самі, що на сервері (`DEFAULT_WORK_HOURS`), доки години філії не
 * завантажено; без переліку днів — кожен день робочий.
 */
export const DEFAULT_WORK_HOURS_WINDOW: Readonly<WorkHoursWindow> = DEFAULT_WORK_HOURS;

const pad = (n: number) => String(n).padStart(2, '0');
const DT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** «YYYY-MM-DDTHH:mm» → день (UTC-північ як лічильник днів) і хвилина доби. */
function parseLocal(value: string): { day: number; minute: number } | null {
  const m = DT_RE.exec(value?.slice(0, 16) ?? '');
  if (!m) return null;
  const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000;
  const minute = Number(m[4]) * 60 + Number(m[5]);
  return Number.isFinite(day) && minute < 24 * 60 ? { day, minute } : null;
}

/** Чи робочий день `day` (лічильник днів `parseLocal`): ISO-день тижня з UTC-півночі дати. */
function isWorkDay(day: number, wh: WorkHoursWindow): boolean {
  const days = wh.workDays;
  if (!days || days.length === 0) return true;
  return days.includes(new Date(day * 86_400_000).getUTCDay() || 7);
}

/** `day`, якщо робочий, інакше перший робочий після нього (не далі тижня). */
function firstWorkDayFrom(day: number, wh: WorkHoursWindow): number {
  let d = day;
  for (let i = 0; i < 7 && !isWorkDay(d, wh); i++) d += 1;
  return d;
}

function formatLocal(day: number, minute: number): string {
  const d = new Date(day * 86_400_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
    Math.floor(minute / 60),
  )}:${pad(minute % 60)}`;
}

/**
 * Планове завершення за початком і нормогодинами в робочих годинах: залишок, що не вміщається
 * до закриття, переноситься на наступний РОБОЧИЙ день від відкриття (скільки завгодно днів,
 * вихідні філії пропускаються). Початок поза вікном чи на вихідному зсувається до найближчого
 * відкриття робочого дня. '' — невалідний ввід.
 */
export function calcEndFromHours(start: string, hours: number, wh: WorkHoursWindow): string {
  const s = parseLocal(start);
  if (!s || !Number.isFinite(hours) || hours <= 0) return '';
  const open = wh.startHour * 60;
  const close = wh.endHour * 60;
  if (close <= open) return '';
  let day = s.day;
  let cur = s.minute;
  if (cur < open) cur = open;
  if (cur >= close) {
    day += 1;
    cur = open;
  }
  const workDay = firstWorkDayFrom(day, wh);
  if (workDay !== day) {
    day = workDay;
    cur = open;
  }
  let remaining = Math.round(hours * 60);
  // Запобіжник від нескінченного циклу на абсурдних нормогодинах.
  for (let i = 0; i < 3660; i++) {
    const available = close - cur;
    if (remaining <= available) return formatLocal(day, cur + remaining);
    remaining -= available;
    day = firstWorkDayFrom(day + 1, wh);
    cur = open;
  }
  return '';
}

/**
 * Нормогодини між плановими початком і завершенням — лише робочий час робочих днів філії (рядок
 * з двома знаками; дзеркало серверного `workHoursBetween`).
 * '' — бракує дати, завершення не пізніше за початок або робочого часу між ними немає.
 */
export function calcPlannedHours(
  start: string | undefined,
  end: string | undefined,
  wh: WorkHoursWindow,
): string {
  const s = start ? parseLocal(start) : null;
  const e = end ? parseLocal(end) : null;
  if (!s || !e) return '';
  if (e.day * 1440 + e.minute <= s.day * 1440 + s.minute) return '';
  const open = wh.startHour * 60;
  const close = wh.endHour * 60;
  let minutes = 0;
  for (let day = s.day; day <= e.day && day - s.day < 3660; day++) {
    if (!isWorkDay(day, wh)) continue;
    const from = Math.max(open, day === s.day ? s.minute : open);
    const to = Math.min(close, day === e.day ? e.minute : close);
    if (to > from) minutes += to - from;
  }
  return minutes > 0 ? String(Math.round((minutes / 60) * 100) / 100) : '';
}
