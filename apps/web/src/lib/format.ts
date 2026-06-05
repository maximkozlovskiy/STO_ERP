/**
 * Frontend formatting singletons — module-level Intl.* інстанси.
 *
 * Чому окремий модуль: `n.toLocaleString('uk-UA', {...})` і `new Date(...).toLocaleDateString(...)`
 * у table-cells `.map(...)` конструюють новий `Intl.NumberFormat` / `Intl.DateTimeFormat` на КОЖНУ
 * комірку × кожен ререндер. Це O(rows × cells × renders) важких ініціалізацій locale-data.
 *
 * Тут — module-level singletons; виклик `fmtMoney(n)` чи `fmtDate(d)` лише виконує `.format()`,
 * який дешевий. Опції зафіксовані як константи (uk-UA, мінімум 2 цифри після крапки).
 *
 * Аналог backend KYIV_DATE_FMT / UAH_FMT (pdf.service, reports.service).
 */

const MONEY_FMT = new Intl.NumberFormat('uk-UA', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const INT_FMT = new Intl.NumberFormat('uk-UA');
const DATE_FMT = new Intl.DateTimeFormat('uk-UA');
const DATETIME_FMT = new Intl.DateTimeFormat('uk-UA', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const SHORT_DATETIME_FMT = new Intl.DateTimeFormat('uk-UA', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const TIME_FMT = new Intl.DateTimeFormat('uk-UA', {
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Форматувати число як суму грн з двома цифрами після крапки.
 * НЕ додає `' ₴'` — викликач сам додає валюту або одиницю.
 *
 * @example fmtMoney(1234.5) → '1 234,50'
 */
export function fmtMoney(n: number | null | undefined): string {
  if (n == null) return '—';
  return MONEY_FMT.format(n);
}

/**
 * Форматувати число цілим uk-UA-стилем (пробіл як роздільник тисяч).
 *
 * @example fmtInt(123456) → '123 456'
 */
export function fmtInt(n: number | null | undefined): string {
  if (n == null) return '—';
  return INT_FMT.format(n);
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
  return DATE_FMT.format(date);
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
  return DATETIME_FMT.format(date);
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
  return SHORT_DATETIME_FMT.format(date);
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
  return TIME_FMT.format(date);
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
