export const LOCALE = 'uk-UA';
export const TIMEZONE = 'Europe/Kyiv';
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
 * Код системного способу оплати «Готівка» (`PaymentMethodConfig.code`, засів організації).
 * Готівка лягає лише в касу (BR-PAY-019): API перевіряє оплату й замовчування способу,
 * web — вікно оплати рахунку й картку способу в НДІ. Одне джерело для обох.
 */
export const CASH_METHOD_CODE = 'cash';
