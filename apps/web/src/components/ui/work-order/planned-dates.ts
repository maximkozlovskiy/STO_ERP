// Планові дати наряду в робочих годинах філії (BR-WO-019): автокінець за нормогодинами і
// нормогодини між початком і завершенням. Значення — київський настінний час
// «YYYY-MM-DDTHH:mm» (як у DateTimePickerInput). Ніч і години поза вікном не рахуються: наряд
// з 16:00 на 3 год при вікні 9–18 закінчується завтра об 10:00 — так само сервер ділить запис
// календаря наряду на дні (BR-WO-020).

export interface WorkHoursWindow {
  startHour: number;
  endHour: number;
}

/** Типові години — як на сервері (`DEFAULT_WORK_HOURS`), доки години філії не завантажено. */
export const DEFAULT_WORK_HOURS_WINDOW: Readonly<WorkHoursWindow> = Object.freeze({
  startHour: 9,
  endHour: 18,
});

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

function formatLocal(day: number, minute: number): string {
  const d = new Date(day * 86_400_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
    Math.floor(minute / 60),
  )}:${pad(minute % 60)}`;
}

/**
 * Планове завершення за початком і нормогодинами в робочих годинах: залишок, що не вміщається
 * до закриття, переноситься на наступний день від відкриття (скільки завгодно днів). Початок
 * поза вікном зсувається до найближчого відкриття. '' — невалідний ввід.
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
  let remaining = Math.round(hours * 60);
  // Запобіжник від нескінченного циклу на абсурдних нормогодинах.
  for (let i = 0; i < 3660; i++) {
    const available = close - cur;
    if (remaining <= available) return formatLocal(day, cur + remaining);
    remaining -= available;
    day += 1;
    cur = open;
  }
  return '';
}

/**
 * Нормогодини між плановими початком і завершенням — лише робочий час (рядок з двома знаками).
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
    const from = Math.max(open, day === s.day ? s.minute : open);
    const to = Math.min(close, day === e.day ? e.minute : close);
    if (to > from) minutes += to - from;
  }
  return minutes > 0 ? String(Math.round((minutes / 60) * 100) / 100) : '';
}
