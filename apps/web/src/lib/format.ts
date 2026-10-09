/**
 * Frontend formatting — locale-aware, з per-locale memoized форматерами.
 *
 * Чому окремий модуль: `n.toLocaleString(...)` / `new Date(...).toLocaleDateString(...)`
 * у table-cells `.map(...)` конструюють новий `Intl.NumberFormat` / `Intl.DateTimeFormat` на КОЖНУ
 * комірку × кожен ререндер. Це O(rows × cells × renders) важких ініціалізацій locale-data.
 *
 * i18n: display-форматери читають поточну локаль (getCurrentIntlLocale → uk-UA / en-US) і кешуються
 * per-locale (build-once, потім лише `.format()`). Перемикання мови → нова локаль → новий форматер
 * будується раз і кешується. TIMEZONE ЗАВЖДИ Europe/Kyiv (мова не впливає на зону).
 *
 * ISO/machine-хелпери (kyivToday, kyivOffsetMs, kyivDateTimeToISO...) — locale-INDEPENDENT
 * (sv-SE/en-CA фіксовані для ISO-виводу). Аналог backend KYIV_DATE_FMT / UAH_FMT.
 */
import { getCurrentIntlLocale } from '@/i18n/locale';

const KYIV_TZ = 'Europe/Kyiv';

// Per-locale memo-кеші: форматер будується раз на локаль, далі лише `.format()`.
function memoByLocale<T>(build: (intlLocale: string) => T): () => T {
  const cache = new Map<string, T>();
  return () => {
    const loc = getCurrentIntlLocale();
    let fmt = cache.get(loc);
    if (!fmt) {
      fmt = build(loc);
      cache.set(loc, fmt);
    }
    return fmt;
  };
}

const getMoneyFmt = memoByLocale(
  loc => new Intl.NumberFormat(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
);
const getIntFmt = memoByLocale(loc => new Intl.NumberFormat(loc));
// T19: date/time прив'язані до Europe/Kyiv. Без timeZone Intl рендерить у TZ браузера/ОС → off-by-one
// на UTC-негативних машинах / невірний час на неправильно налаштованому ПК. СТО завжди у Києві.
const getDateFmt = memoByLocale(loc => new Intl.DateTimeFormat(loc, { timeZone: KYIV_TZ }));
const getDateTimeFmt = memoByLocale(
  loc =>
    new Intl.DateTimeFormat(loc, {
      timeZone: KYIV_TZ,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
);
const getShortDateTimeFmt = memoByLocale(
  loc =>
    new Intl.DateTimeFormat(loc, {
      timeZone: KYIV_TZ,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }),
);
const getTimeFmt = memoByLocale(
  loc =>
    new Intl.DateTimeFormat(loc, {
      timeZone: KYIV_TZ,
      hour: '2-digit',
      minute: '2-digit',
    }),
);

/**
 * Форматувати число як суму грн з двома цифрами після крапки.
 * НЕ додає `' ₴'` — викликач сам додає валюту або одиницю.
 *
 * @example fmtMoney(1234.5) → '1 234,50'
 */
export function fmtMoney(n: number | null | undefined): string {
  if (n == null) return '—';
  return getMoneyFmt().format(n);
}

/**
 * Суфікс валюти суми з рахунку банку (multi-bank: рахунок може бути USD/EUR). Не хардкодимо ₴:
 * для UAH/невідомого коду показуємо ₴, для інших — код валюти рахунку.
 *
 * @example fmtBankCurrencySuffix('UAH') → '₴'; fmtBankCurrencySuffix('USD') → 'USD'
 */
export function fmtBankCurrencySuffix(code: string | null | undefined): string {
  return !code || code === 'UAH' ? '₴' : code;
}

/**
 * Форматувати число цілим uk-UA-стилем (пробіл як роздільник тисяч).
 *
 * @example fmtInt(123456) → '123 456'
 */
export function fmtInt(n: number | null | undefined): string {
  if (n == null) return '—';
  return getIntFmt().format(n);
}

/**
 * Форматувати дату як `DD.MM.YYYY` (uk-UA). Приймає string|Date|null.
 *
 * @example fmtDate('2026-05-30') → '30.05.2026'
 */
export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  return getDateFmt().format(date);
}

/**
 * Форматувати дату+час як `DD.MM.YYYY, HH:mm` (uk-UA).
 *
 * @example fmtDateTime('2026-05-30T14:30:00Z') → '30.05.2026, 17:30'
 */
export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  return getDateTimeFmt().format(date);
}

/**
 * Короткий формат «день.місяць, година:хвилина» — без року.
 * Підходить для коментарів/audit-event timestamp у `.map()`.
 *
 * @example fmtShortDateTime('2026-05-30T14:30:00Z') → '30.05, 17:30'
 */
export function fmtShortDateTime(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  return getShortDateTimeFmt().format(date);
}

/**
 * Форматувати час як `HH:mm` (uk-UA, 24h). Підходить для notification timestamp у `.map()`,
 * sync-indicator title (TopShell, рендериться на кожній сторінці).
 *
 * @example fmtTime('2026-05-30T14:30:00Z') → '17:30'
 */
export function fmtTime(d: string | Date | number | null | undefined): string {
  if (d == null) return '—';
  const date = typeof d === 'number' || typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  return getTimeFmt().format(date);
}

/**
 * Сьогоднішня дата у часовому поясі Kyiv як рядок `YYYY-MM-DD`.
 * DST-aware: використовує sv-SE локаль (ISO формат) + Europe/Kyiv timezone.
 *
 * Безпечна для SSR — не використовує window/document, тільки Intl API.
 * Централізована заміна 14 копій `const KYIV_YMD + const kyivToday` у page.tsx файлах.
 *
 * @example kyivToday() → '2026-06-05'
 */
const KYIV_YMD_FMT = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' });

export function kyivToday(): string {
  return KYIV_YMD_FMT.format(new Date());
}

/**
 * Київська календарна дата `YYYY-MM-DD` мітки часу (ISO-рядок із API — це UTC). Порівнювати з
 * `kyivToday()` треба саме її, а не `iso.slice(0, 10)`: перші дві-три години київської доби в UTC
 * ще належать вчорашньому дню (Bug #812). Невалідна або порожня мітка → `''`.
 */
export function kyivDateOf(d: string | Date | null | undefined): string {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? '' : KYIV_YMD_FMT.format(date);
}

/**
 * Форма календарної дати `YYYY-MM-DD`, яку приймає API. Рідний `<input type="date">` дозволяє
 * набрати рік із 5–6 цифр (`20261-10-09`) або лишити поле порожнім — таке значення у запит не йде.
 */
export const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Додає `days` днів до дати `YYYY-MM-DD` і повертає `YYYY-MM-DD` (UTC-арифметика, без DST-стрибків). */
export function addDaysISO(ymd: string, days: number): string {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * DST-aware offset for `Europe/Kyiv` at a given UTC instant (in ms).
 * Returns +02h у зимовий період, +03h у літній. Не залежить від local TZ браузера.
 *
 * @example kyivOffsetMs(new Date('2026-01-15')) → 7_200_000 (зима EET +02)
 * @example kyivOffsetMs(new Date('2026-07-15')) → 10_800_000 (літо EEST +03)
 */
const KYIV_HOUR_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Kyiv',
  hour: '2-digit',
  hour12: false,
});

export function kyivOffsetMs(d: Date): number {
  const kyivHour = parseInt(KYIV_HOUR_FMT.format(d), 10);
  const utcHour = d.getUTCHours();
  // Wrap-around: якщо Kyiv 01:00 а UTC 23:00 попереднього дня → kyivHour=1, utcHour=23, diff=-22 → норм +2.
  return ((kyivHour - utcHour + 24) % 24) * 3_600_000;
}

/**
 * Convert a Kyiv-local wall-clock date+time to a true UTC ISO string.
 * DST-aware. Не залежить від local TZ браузера.
 *
 * @example kyivDateTimeToISO('2026-06-05', '09:00') → '2026-06-05T06:00:00.000Z' (літо)
 * @example kyivDateTimeToISO('2026-01-15', '09:00') → '2026-01-15T07:00:00.000Z' (зима)
 *
 * Backend `@IsISO8601()` приймає обидва формати; UTC `Z` явно вказує що це true UTC.
 */
export function kyivDateTimeToISO(date: string, time: string): string {
  // Парсимо як UTC-naive, потім зміщуємо назад на DST-aware offset для Києва.
  const naive = new Date(`${date}T${time}:00Z`);
  if (Number.isNaN(naive.getTime())) return '';
  const offset = kyivOffsetMs(naive);
  return new Date(naive.getTime() - offset).toISOString();
}

/**
 * Convert a UTC ISO string (from API) to a Kyiv-local datetime string for
 * <input type="datetime-local"> — format "YYYY-MM-DDTHH:mm". DST-aware.
 *
 * @example isoToKyivLocalDateTime('2026-06-12T05:30:00.000Z') → '2026-06-12T08:30'
 * @example isoToKyivLocalDateTime('2026-01-15T07:00:00.000Z') → '2026-01-15T09:00'
 */
const KYIV_DATETIME_LOCAL_FMT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Kyiv',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function isoToKyivLocalDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // sv-SE format: "2026-06-12 08:30" → replace space with T for datetime-local
  return KYIV_DATETIME_LOCAL_FMT.format(d).replace(' ', 'T');
}

/**
 * Convert a Kyiv-local datetime-local input value ("YYYY-MM-DDTHH:mm") to a UTC
 * ISO string for the API. Already-zoned strings (ending Z or ±HH:mm) pass through.
 * Returns undefined for empty/invalid input so optional fields stay absent in API payloads.
 *
 * @example localDateTimeToISO('2026-06-10T19:00') → '2026-06-10T16:00:00.000Z' (літо)
 * @example localDateTimeToISO('2026-06-10T16:00:00.000Z') → '2026-06-10T16:00:00.000Z' (pass-through)
 * @example localDateTimeToISO('') → undefined
 */
export function localDateTimeToISO(v: string): string | undefined {
  if (!v) return undefined;
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(v)) return v;
  const [d, t] = v.split('T');
  if (!d || !t) return undefined;
  const iso = kyivDateTimeToISO(d, t.slice(0, 5));
  return iso || undefined;
}
