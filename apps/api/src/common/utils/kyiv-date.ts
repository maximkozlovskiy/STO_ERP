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

/**
 * DST-aware offset for Europe/Kyiv at the given UTC instant, in **milliseconds**.
 * Returns +7_200_000 (EET +02:00) у зимовий період, +10_800_000 (EEST +03:00) у літній.
 *
 * Logic-bug fix: попередня реалізація ділила різницю мілісекунд на 60_000 → результат у
 * хвилинах попри назву `…Ms`. Метод був мертвим кодом (жоден сервіс не імпортував його з
 * цього файлу — кожен мав власну копію в reports.service / calendar.service), але назва
 * обіцяла ms, що мало шанси на silent failure при першому ж новому імпорті.
 */
export const kyivOffsetMs = (d: Date): number => {
  const kyivStr = d.toLocaleString('en-US', { timeZone: 'Europe/Kyiv', hour12: false });
  const kyivDate = new Date(kyivStr + ' UTC');
  // toLocaleString віддає час до секунди, без мілісекунд. Для миті з мілісекундами (кінець
  // доби 23:59:59.999) різниця з d виходила на 999 мс меншою за справжній зсув, і межа
  // «по день» з'їжджала на першу секунду наступної доби. Порівнюємо з d, обрізаним до секунди.
  return kyivDate.getTime() - Math.floor(d.getTime() / 1000) * 1000;
};

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
  if (from) {
    const d = new Date(`${from}T00:00:00Z`);
    range.gte = new Date(d.getTime() - kyivOffsetMs(d));
  }
  if (to) {
    const d = new Date(`${to}T23:59:59.999Z`);
    range.lte = new Date(d.getTime() - kyivOffsetMs(d));
  }
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

/** YYYY-MM-DD, що існує в календарі (31.02 → false): для query-параметрів без DTO. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Перетворює YYYY-MM-DD діапазон (from/to) у UTC-межі Kyiv-доби: `fromDate` = початок дня від,
 * `toDate` = кінець дня до. DST-aware через kyivOffsetMs. Кидає 400 якщо from > to.
 * Спільне джерело для reports + report-builder (раніше дублювалось у reports.service).
 */
export function normalizeKyivDateRange(from: string, to: string): { fromDate: Date; toDate: Date } {
  const fromMidnight = new Date(`${from}T00:00:00Z`);
  const toEndOfDay = new Date(`${to}T23:59:59.999Z`);
  const fromDate = new Date(fromMidnight.getTime() - kyivOffsetMs(fromMidnight));
  const toDate = new Date(toEndOfDay.getTime() - kyivOffsetMs(toEndOfDay));
  return { fromDate, toDate };
}
