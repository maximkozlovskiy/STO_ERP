import { DEFAULT_WORK_DAYS, DEFAULT_WORK_HOURS } from '@sto/shared';
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
  /**
   * Робочі дні тижня (ISO: 1 = пн … 7 = нд, BR-WO-019 / BR-CAL-016). Немає поля чи порожній
   * перелік — типові пн–пт (`DEFAULT_WORK_DAYS`, BR-CAL-017): рядок налаштувань є в кожної
   * філії, а перелік не буває порожнім, тож це лише запасне значення (запис без підйомника,
   * збій читання).
   */
  readonly workDays?: readonly number[];
}

/** Типові години й дні — філія без рядка налаштувань, запис без підйомника, збій читання. */
export const DEFAULT_BRANCH_HOURS: WorkHours = Object.freeze({
  ...DEFAULT_WORK_HOURS,
  workDays: DEFAULT_WORK_DAYS,
});

const DAY_MS = 86_400_000;
/** Запобіжник `splitByWorkHours` від нескінченного циклу: не більше року днів. */
const MAX_SPLIT_DAYS = 366;
/** Запобіжник `endFromWorkHours` на абсурдних нормогодинах — як web `calcEndFromHours`. */
const MAX_END_DAYS = 3660;

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
 * початку (дані до валідації DTO) → типові години цілком, а не наполовину. Робочі дні — з рядка
 * (`workDaysOf`); немає рядка, поля чи жодного валідного дня — пн–пт (BR-CAL-016, BR-CAL-017).
 */
export function workHoursOf(
  row:
    | { workStartTime?: string | null; workEndTime?: string | null; workDays?: unknown }
    | null
    | undefined,
): WorkHours {
  if (!row) return DEFAULT_BRANCH_HOURS;
  const workDays = workDaysOf(row);
  const startHour = parseWorkHour(row.workStartTime, DEFAULT_WORK_HOURS.startHour);
  const endHour = parseWorkHour(row.workEndTime, DEFAULT_WORK_HOURS.endHour);
  return endHour > startHour
    ? { startHour, endHour, workDays }
    : { ...DEFAULT_WORK_HOURS, workDays };
}

/**
 * Робочі дні тижня з рядка `BranchSettings` (ISO: 1 = пн … 7 = нд — так їх пише вкладка
 * «Робочі дні» і читає онлайн-запис, BR-CAL-004): цілі 1..7 без повторів, за зростанням. Немає
 * рядка, `workDays` не масив чи в ньому жодного валідного дня → пн–пт (`DEFAULT_WORK_DAYS`,
 * BR-CAL-017: порожнього переліку не буває; до 2026-11-06 порожній перелік давав онлайн-запису і
 * звітам «жодного дня», а нарядам і календарю — «кожен день»).
 */
export function workDaysOf(row: { workDays?: unknown } | null | undefined): readonly number[] {
  const raw = row?.workDays;
  if (!Array.isArray(raw)) return DEFAULT_WORK_DAYS;
  const days = [
    ...new Set(
      raw.filter(
        (d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 1 && d <= 7,
      ),
    ),
  ].sort((a, b) => a - b);
  return days.length > 0 ? days : DEFAULT_WORK_DAYS;
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

/** ISO-день тижня (1 = пн … 7 = нд) київської дати `YYYY-MM-DD` — з полудня UTC, без DST. */
function isoWeekday(ymd: string): number {
  return new Date(`${ymd}T12:00:00Z`).getUTCDay() || 7;
}

/** Робочі дні годин; немає чи порожній перелік — пн–пт (BR-CAL-016). */
function workDaysOfHours(hours: Pick<WorkHours, 'workDays'>): readonly number[] {
  const days = hours.workDays;
  return days && days.length > 0 ? days : DEFAULT_WORK_DAYS;
}

/**
 * Чи робочий київський день `ymd` для філії (BR-WO-019, BR-CAL-016). Переліку днів немає чи він
 * порожній — пн–пт (`DEFAULT_WORK_DAYS`), як скрізь.
 */
export function isWorkDay(ymd: string, hours: Pick<WorkHours, 'workDays'>): boolean {
  return workDaysOfHours(hours).includes(isoWeekday(ymd));
}

/**
 * Робочі дні для відповіді `GET /settings/work-hours`: перелік із годин без повторів за
 * зростанням; немає чи порожній — пн–пт явно, щоб клієнтові не треба було знати запасного значення.
 */
export function effectiveWorkDays(hours: Pick<WorkHours, 'workDays'>): number[] {
  return [...new Set(workDaysOfHours(hours))].sort((a, b) => a - b);
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

/**
 * Наступний РОБОЧИЙ київський день після `ymd` (BR-CAL-016): сюди переходить залишок запису, що
 * виходить за закриття. Вихідні філії пропускаються; тиждень — межа пошуку.
 */
export function nextWorkDay(ymd: string, hours: Pick<WorkHours, 'workDays'>): string {
  let day = nextKyivDay(ymd);
  for (let i = 0; i < 6 && !isWorkDay(day, hours); i++) day = nextKyivDay(day);
  return day;
}

export interface TimeSegment {
  startAt: Date;
  endAt: Date;
}

/**
 * Кінець запису «початок + тривалість» (BR-CAL-007, №72): форма й старі клієнти шлють кінець на
 * ТОМУ Ж київському дні, навіть коли запис виходить за закриття робочого дня (17:00 + 3 год →
 * 20:00). Залишок після закриття переходить на наступні РОБОЧІ дні від відкриття — на стільки
 * днів, скільки потрібно (вихідні філії пропускаються, BR-CAL-016; до 2026-11-06 — лише на один
 * день). Кінець на іншому дні — уже справжня мить завершення (форма рахує її за робочими годинами,
 * `calcEndFromHours`) і повертається як є; так само запис, що не перетинає закриття, і запис, що
 * починається у вихідний філії чи о закритті й пізніше (BR-CAL-007 — один запис).
 */
export function overflowEnd(startAt: Date, endAt: Date, hours: WorkHours): Date {
  const day = kyivYmd(startAt);
  const close = kyivHourOnDay(day, hours.endHour);
  if (!(isWorkDay(day, hours) && startAt < close && endAt > close && kyivYmd(endAt) === day))
    return endAt;
  const perDayMs = (hours.endHour - hours.startHour) * 3_600_000;
  if (!(perDayMs > 0)) return endAt;
  let remaining = endAt.getTime() - close.getTime();
  let next = day;
  for (let i = 0; i < MAX_SPLIT_DAYS; i++) {
    next = nextWorkDay(next, hours);
    if (remaining <= perDayMs)
      return new Date(kyivHourOnDay(next, hours.startHour).getTime() + remaining);
    remaining -= perDayMs;
  }
  return endAt;
}

/**
 * Проміжок [start, end) у межах робочих годин: по відрізку на кожен київський день, де проміжок
 * перетинає робоче вікно `startHour..endHour`. Наряд з 10:00 сьогодні до 12:00 завтра (вікно 9–18)
 * дає 10:00–18:00 і 09:00–12:00 — запис календаря займає підйомник лише в робочий час (BR-WO-020).
 * Дні без перетину і вихідні філії (`hours.workDays`, BR-CAL-016) відрізків не мають.
 */
export function splitByWorkHours(start: Date, end: Date, hours: WorkHours): TimeSegment[] {
  const out: TimeSegment[] = [];
  if (!(end.getTime() > start.getTime())) return out;
  const lastDay = kyivYmd(end);
  let day = kyivYmd(start);
  for (let i = 0; i < MAX_SPLIT_DAYS; i++) {
    if (isWorkDay(day, hours)) {
      const open = kyivHourOnDay(day, hours.startHour);
      const close = kyivHourOnDay(day, hours.endHour);
      const segStart = Math.max(start.getTime(), open.getTime());
      const segEnd = Math.min(end.getTime(), close.getTime());
      if (segEnd > segStart) out.push({ startAt: new Date(segStart), endAt: new Date(segEnd) });
    }
    if (day === lastDay) break;
    day = nextKyivDay(day);
  }
  return out;
}

/**
 * Робочі години між датами (у межах годин філії, без вихідних філії — BR-WO-019), до сотих —
 * те, що картка наряду показує в «Нормогодин» і перераховує при зміні дат (`calcPlannedHours`
 * у web). Зміна меж запису змінює тривалість наряду, тож і його планові нормогодини (Bug #903).
 * Зворотна до `endFromWorkHours`.
 */
export function workHoursBetween(start: Date, end: Date, hours: WorkHours): number {
  const ms = splitByWorkHours(start, end, hours).reduce(
    (sum, s) => sum + (s.endAt.getTime() - s.startAt.getTime()),
    0,
  );
  return Math.round((ms / 3_600_000) * 100) / 100;
}

/**
 * Кінець за початком і нормогодинами в робочих годинах філії (BR-WO-019) — дзеркало web
 * `calcEndFromHours` (`components/ui/work-order/planned-dates.ts`), тож картка наряду й сервер
 * рахують однаково: початок до відкриття — від відкриття, о закритті й пізніше чи у вихідний — від
 * відкриття наступного робочого дня; залишок, що не вміщається до закриття, — на наступні РОБОЧІ
 * дні (вихідні філії пропускаються). Залишок рівно до закриття — закриття того ж дня, а не
 * відкриття наступного. Зворотна до `workHoursBetween`. `null` — невалідний ввід (години ≤ 0,
 * невалідна дата, порожнє вікно).
 */
export function endFromWorkHours(start: Date, hours: number, wh: WorkHours): Date | null {
  if (Number.isNaN(start.getTime()) || !Number.isFinite(hours) || hours <= 0) return null;
  const open = wh.startHour * 60;
  const close = wh.endHour * 60;
  if (close <= open) return null;
  let day = kyivYmd(start);
  let cur = Math.max(open, kyivMinuteOfDay(start));
  if (cur >= close) {
    day = nextKyivDay(day);
    cur = open;
  }
  if (!isWorkDay(day, wh)) {
    day = nextWorkDay(day, wh);
    cur = open;
  }
  let remaining = Math.round(hours * 60);
  for (let i = 0; i < MAX_END_DAYS; i++) {
    const available = close - cur;
    if (remaining <= available) return kyivHourOnDay(day, (cur + remaining) / 60);
    remaining -= available;
    day = nextWorkDay(day, wh);
    cur = open;
  }
  return null;
}

/**
 * Ті самі робочі години й робочі дні (BR-CAL-016/017): запис, що переходить на підйомник такої
 * філії, нормогодин не перераховує (№98).
 */
export function sameWorkHours(a: WorkHours, b: WorkHours): boolean {
  return (
    a.startHour === b.startHour &&
    a.endHour === b.endHour &&
    effectiveWorkDays(a).join(',') === effectiveWorkDays(b).join(',')
  );
}

/**
 * Закриття дня початку, якщо запис без наряду з цього початку ділиться на дні (робочий день філії
 * і до закриття, BR-CAL-007); інакше `null` — запис один, «початок + тривалість».
 */
function splitCloseOf(start: Date, wh: WorkHours): Date | null {
  if (wh.endHour <= wh.startHour) return null;
  const day = kyivYmd(start);
  const close = kyivHourOnDay(day, wh.endHour);
  return isWorkDay(day, wh) && start < close ? close : null;
}

/**
 * Нормогодини запису без наряду (BR-CAL-007, BR-CAL-020) — дзеркало web `slotHoursBetween`
 * (`calendar-slot-span.ts`): кінець того ж дня — тривалість; кінець іншого дня з робочого початку —
 * години першого дня до закриття плюс робочі години після нього. 0 — кінець не пізніше початку.
 */
export function slotWorkHours(start: Date, end: Date, wh: WorkHours): number {
  if (!(end.getTime() > start.getTime())) return 0;
  const close = splitCloseOf(start, wh);
  const ms =
    close && kyivYmd(end) !== kyivYmd(start)
      ? close.getTime() -
        start.getTime() +
        // Години після закриття — цілими хвилинами, як форма (`Math.round(after * 60)`): інакше
        // сотні години (0,02 год = 1,2 хв) зсувають підсумок на соту (пт 17:59 → пн 09:01).
        Math.round(workHoursBetween(close, end, wh) * 60) * 60_000
      : end.getTime() - start.getTime();
  return Math.round((ms / 3_600_000) * 100) / 100;
}

/**
 * Кінець запису без наряду за початком і нормогодинами (BR-CAL-007, №72) — дзеркало web
 * `slotEndFromHours`: «початок + тривалість»; з робочого початку частина за закриттям переходить на
 * наступні робочі дні від відкриття (`endFromWorkHours`). Зворотна до `slotWorkHours`. `null` —
 * години ≤ 0 чи невалідна дата.
 */
export function slotEndFromWorkHours(start: Date, hours: number, wh: WorkHours): Date | null {
  if (Number.isNaN(start.getTime()) || !Number.isFinite(hours) || hours <= 0) return null;
  const total = new Date(start.getTime() + Math.round(hours * 60) * 60_000);
  const close = splitCloseOf(start, wh);
  if (!close || total <= close) return total;
  return endFromWorkHours(close, (total.getTime() - close.getTime()) / 3_600_000, wh) ?? total;
}
