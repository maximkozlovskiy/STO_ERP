export const LOCALE = 'uk-UA';
export const TIMEZONE = 'Europe/Kyiv';

/**
 * Форма календарної дати `YYYY-MM-DD` — ЄДИНЕ визначення для api (DTO `@Matches`), web і схем форм.
 * Року 0000 у календарі немає (JS читає його як 1 р. до н. е., Postgres відхиляє — Bug #818). Чи
 * існує сам день (31.02), перевіряє `isCalendarDate` в api.
 */
export const CALENDAR_DATE_RE = /^(?!0000)\d{4}-\d{2}-\d{2}$/;

/** Сьогоднішня дата за Києвом, `YYYY-MM-DD` (en-CA дає саме цей формат). */
export function kyivTodayYmd(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(now);
}
export const CURRENCY = 'UAH';
export const CURRENCY_SYMBOL = '₴';

export const JWT_ACCESS_EXPIRES = '15m';
export const JWT_REFRESH_EXPIRES = '30d';

export const PAGINATION_DEFAULT_LIMIT = 20;
export const PAGINATION_MAX_LIMIT = 100;

// Safety cap for unbounded findMany — prevents OOM on large datasets
export const MAX_QUERY_LIMIT = 1000;

// Default Prisma $transaction timeout in milliseconds
export const TRANSACTION_TIMEOUT_MS = 5_000;

/**
 * Типові робочі години філії (київський час): 09:00–18:00, як `@default` колонок
 * `BranchSettings.workStartTime/workEndTime`. Одне джерело для API (розбиття запису календаря на
 * дні, BR-CAL-007; перевірка планових дат наряду, BR-WO-019; `GET /settings/work-hours`) і web
 * (сітка календаря, пікер планових дат), доки години філії не завантажено чи їх немає.
 */
export const DEFAULT_WORK_HOURS: Readonly<{ startHour: number; endHour: number }> = Object.freeze({
  startHour: 9,
  endHour: 18,
});

/**
 * Найбільша довжина рядка пошуку `q` у списках: поле вводу у web обмежене цим самим числом,
 * API обрізає або відхиляє довший рядок. Одне джерело, щоб межі не розійшлись (Bug #816).
 */
export const LIST_SEARCH_MAX_LENGTH = 100;

/**
 * Найбільше товарів у списку одного правила ціноутворення (BR-GOOD-009). Одне число для
 * перевірки в API, для форми правила і для завантаження списку з файла.
 */
export const PRICING_RULE_MAX_GOODS = 5000;

/**
 * Гарантія «закінчується» — до кінця лишилось не більше стількох календарних днів за Києвом
 * (BR-WAR-002). Один поріг для віджета дашборду й вкладки «Гарантії» нарядів. 14, а не 30 (рішення
 * власника 2026-10-22): гарантія за замовчуванням — 30 днів, і з порогом 30 кожна нова одразу
 * «закінчувалась», стан «Діє» не з'являвся.
 */
export const WARRANTY_EXPIRING_DAYS = 14;

/**
 * Одиниця роботи в рахунку (BR-INV-021): кількість роботи — години (факт, інакше норма), тож рядок
 * роботи без власної одиниці показується й друкується з «год» (рішення власника 2026-10-22; раніше
 * друкувалось «шт»).
 */
export const WORK_UNIT_SHORT_NAME = 'год';

/**
 * Одиниця товару за замовчуванням — ДАНІ (`Good.unit`, як у `GoodsService.create`), а не підпис
 * інтерфейсу: пишеться в базу однаково за будь-якої мови інтерфейсу.
 */
export const DEFAULT_GOOD_UNIT = 'шт';

/**
 * Стан гарантії у списку вкладки «Гарантії» (BR-WAR-002): обчислює сервер, фільтр `?state=` бере
 * ці самі значення. Порядок — порядок пунктів фільтра у web.
 */
export const WARRANTY_STATES = ['ACTIVE', 'EXPIRING', 'EXPIRED', 'CLAIMED'] as const;
export type WarrantyState = (typeof WARRANTY_STATES)[number];

/**
 * Код системного способу оплати «Готівка» (`PaymentMethodConfig.code`, засів організації).
 * Готівка лягає лише в касу (BR-PAY-019): API перевіряє оплату й замовчування способу,
 * web — вікно оплати рахунку й картку способу в НДІ. Одне джерело для обох.
 */
export const CASH_METHOD_CODE = 'cash';

/**
 * Онлайн-спосіб оплати (QR-еквайринг): код `<шлюз>_qr` (`monobank_qr`, `privat24_qr`, `liqpay_qr`;
 * засів організації, `payment-polling.processor`). Без урахування регістру: картка НДІ пише код
 * великими літерами. Гроші приходять від шлюзу на банківський рахунок — каса призначенням такого
 * способу неможлива (BR-PAY-031).
 */
export function isOnlineMethodCode(code: string | null | undefined): boolean {
  return !!code && /_qr$/i.test(code);
}
