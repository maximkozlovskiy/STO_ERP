const KYIV_YMD = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' });

export const kyivToday = (): Date => new Date(KYIV_YMD.format(new Date()));

/**
 * Kyiv-локальна календарна дата інстанту у форматі 'YYYY-MM-DD' (DST-aware через Intl).
 * Для date-only облікових прив'язок (курс валюти на дату операції тощо), де дата має відповідати
 * Kyiv-добі, а не UTC: інстант 2026-09-14T22:30Z (01:30 Kyiv, EEST) → '2026-09-15', а НЕ '2026-09-14'.
 * Курси НБУ зберігаються під Kyiv-датою (nbu-fetch), тож lookup теж має бути під Kyiv-датою.
 */
export const kyivYmd = (d: Date): string => KYIV_YMD.format(d);

/**
 * Додає `days` календарних днів до дати `base` і повертає нову Date (date-only, Kyiv).
 * Для `@db.Date` колонок TZ-нюансів немає — беремо Kyiv-локальну опівнічну дату (KYIV_YMD)
 * і додаємо дні через UTC-арифметику, щоб уникнути DST-стрибків.
 */
export const addDaysKyiv = (base: Date, days: number): Date => {
  const ymd = KYIV_YMD.format(base); // 'YYYY-MM-DD' у Kyiv
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return new Date(d.toISOString().slice(0, 10));
};

/** 400 Gregorian years are exactly 146 097 days. */
const GREGORIAN_CYCLE_MS = 146_097 * 86_400_000;

/**
 * DST-aware offset for Europe/Kyiv at the given UTC instant, in **milliseconds**.
 * Returns +7_200_000 (EET +02:00) у зимовий період, +10_800_000 (EEST +03:00) у літній.
 * Для дат до 1924 року — місцевий середній час Києва, +7_324_000 (+02:02:04).
 *
 * Logic-bug fix: попередня реалізація ділила різницю мілісекунд на 60_000 → результат у
 * хвилинах попри назву `…Ms`. Метод був мертвим кодом (жоден сервіс не імпортував його з
 * цього файлу — кожен мав власну копію в reports.service / calendar.service), але назва
 * обіцяла ms, що мало шанси на silent failure при першому ж новому імпорті.
 */
export const kyivOffsetMs = (d: Date): number => {
  // Bug #818: years 0-99 print without leading zeros ("10/9/2"), and `new Date` reads them back
  // as 19xx/20xx - the "offset" came out ~2000 years and the day boundary went to Prisma as a
  // date Postgres rejects (500). A native date input emits exactly such values while the year is
  // being typed (0002-.., 0020-..). Probe the same instant one Gregorian cycle (400 years) later:
  // same calendar, same local-mean-time offset.
  if (d.getUTCFullYear() < 100) return kyivOffsetMs(new Date(d.getTime() + GREGORIAN_CYCLE_MS));
  const kyivStr = d.toLocaleString('en-US', { timeZone: 'Europe/Kyiv', hour12: false });
  const kyivDate = new Date(kyivStr + ' UTC');
  // toLocaleString віддає час до секунди, без мілісекунд. Для миті з мілісекундами (кінець
  // доби 23:59:59.999) різниця з d виходила на 999 мс меншою за справжній зсув, і межа
  // «по день» з'їжджала на першу секунду наступної доби. Порівнюємо з d, обрізаним до секунди.
  return kyivDate.getTime() - Math.floor(d.getTime() / 1000) * 1000;
};

/** Earliest instant Postgres accepts in an ISO timestamp: 0001-01-01T00:00:00Z. */
const EARLIEST_DB_INSTANT_MS = new Date('0001-01-01T00:00:00.000Z').getTime();

/** Настінний час `YYYY-MM-DDTHH:mm:ss[.sss]` київського дня → мить UTC (DST-aware). */
const kyivWallTimeToUtc = (wallTime: string): Date => {
  const d = new Date(`${wallTime}Z`);
  // Bug #818: the start of Kyiv day 0001-01-01 is 31.12 of year 0 in UTC, and Postgres has no
  // year 0 - the query failed with 500. Nothing is stored that early, so the floor is harmless.
  return new Date(Math.max(d.getTime() - kyivOffsetMs(d), EARLIEST_DB_INSTANT_MS));
};

/** Початок київського дня `YYYY-MM-DD` (00:00:00.000) як мить UTC. */
export const kyivDayStart = (ymd: string): Date => kyivWallTimeToUtc(`${ymd}T00:00:00`);

/** Кінець київського дня `YYYY-MM-DD` (23:59:59.999) як мить UTC. */
export const kyivDayEnd = (ymd: string): Date => kyivWallTimeToUtc(`${ymd}T23:59:59.999`);

/**
 * Фільтр «з дня / по день» для списків документів: кожна межа необов'язкова, обидві включні,
 * день — КИЇВСЬКИЙ (DST-aware). Повертає `undefined`, якщо жодної межі не задано — тоді умову
 * на дату в `where` не додають. Для колонок-міток часу (`DateTime`); для `@db.Date` межі
 * порівнюють датою без часу — див. `dateOnlyRangeFilter`.
 */
export function kyivDayRangeFilter(
  from?: string,
  to?: string,
): { gte?: Date; lte?: Date } | undefined {
  if (!from && !to) return undefined;
  const range: { gte?: Date; lte?: Date } = {};
  if (from) range.gte = kyivDayStart(from);
  if (to) range.lte = kyivDayEnd(to);
  return range;
}

/**
 * Те саме для колонки `@db.Date` (дата БЕЗ часу, напр. дата банківської операції): межі — самі
 * календарні дати. Зсув на київський пояс тут був би помилкою — «09.10» у базі це 09.10, а не
 * мить часу, і `gte 08.10T21:00Z` зачепив би попередній день.
 */
export function dateOnlyRangeFilter(
  from?: string,
  to?: string,
): { gte?: Date; lte?: Date } | undefined {
  if (!from && !to) return undefined;
  return {
    ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
    ...(to ? { lte: new Date(`${to}T00:00:00.000Z`) } : {}),
  };
}

/** Форма календарної дати `YYYY-MM-DD` (без часу). Існування дня перевіряє `isCalendarDate`. */
export const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD, що існує в календарі (31.02 → false): для query-параметрів без DTO. */
export function isCalendarDate(value: string): boolean {
  // Bug #818: the calendar has no year 0000 (JS reads it as 1 BC, Postgres rejects it).
  if (!CALENDAR_DATE_RE.test(value) || value.startsWith('0000-')) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Перетворює YYYY-MM-DD діапазон (from/to) у UTC-межі Kyiv-доби: `fromDate` = початок дня від,
 * `toDate` = кінець дня до. DST-aware через kyivDayStart / kyivDayEnd. Порядок меж (from ≤ to)
 * перевіряє викликач — сама функція нічого не кидає.
 * Використовує report-builder; reports.service, payroll.service і calendar.service досі мають
 * власні копії меж доби (TECH-DEBT §8).
 */
export function normalizeKyivDateRange(from: string, to: string): { fromDate: Date; toDate: Date } {
  return { fromDate: kyivDayStart(from), toDate: kyivDayEnd(to) };
}
