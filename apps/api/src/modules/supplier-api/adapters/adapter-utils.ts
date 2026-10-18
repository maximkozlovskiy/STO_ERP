import { normalizeArticle } from '../../../common/utils/normalize-article';
import { kyivYmd } from '../../../common/utils/kyiv-date';
import { SupplierAuthError, SupplierProtocolError } from '../http/supplier-errors';
import type { NormalizedOffer, SupplierConnectionContext } from './supplier-adapter.interface';

/**
 * Кількість від постачальника: число, «12», «> 10», «>10», «10+», «≥10», «-».
 * Межа («більше ніж») → `lowerBound`: qty — нижня межа (BR-SOFR-001). «>» без числа — є, але
 * скільки невідомо: 1 як нижня межа.
 */
export function parseQty(raw: unknown): { qty: number; lowerBound: boolean } {
  if (typeof raw === 'number') return { qty: Number.isFinite(raw) ? raw : 0, lowerBound: false };
  if (typeof raw !== 'string') return { qty: 0, lowerBound: false };
  const s = raw.trim().replace(',', '.');
  if (!s || s === '-') return { qty: 0, lowerBound: false };
  const lowerBound = /^(>|≥|>=)/.test(s) || /\+$/.test(s);
  const n = Number(
    s
      .replace(/^(>=|>|≥)\s*/, '')
      .replace(/\+$/, '')
      .trim(),
  );
  if (!Number.isFinite(n)) return { qty: lowerBound ? 1 : 0, lowerBound };
  return { qty: n, lowerBound };
}

/** Ціна з рядка «325.50» / «325,50» / числа; не число → NaN (такі пропозиції відкидаються). */
export function parsePrice(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') return Number(raw.trim().replace(/\s/g, '').replace(',', '.'));
  return Number.NaN;
}

export function positiveIntOrNull(raw: unknown): number | null {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/** Дата постачальника (ISO / «YYYY-MM-DD» / «YYYY-MM-DD HH:mm:ss») → Date або null. */
export function parseSupplierDate(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim().replace(' ', 'T');
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** BR-SOFR-001: пропозиція без кількості чи ціни не зберігається. */
export function keepValidOffers(offers: NormalizedOffer[]): NormalizedOffer[] {
  return offers.filter(
    o => Number.isFinite(o.price) && o.price > 0 && Number.isFinite(o.qty) && o.qty > 0,
  );
}

/** Бренди порівнюються без регістру й розділових знаків (MANN-FILTER = Mann Filter). */
export function sameBrand(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return true;
  return normalizeArticle(a) === normalizeArticle(b);
}

export function sameArticle(a: string, b: string): boolean {
  return normalizeArticle(a) === normalizeArticle(b);
}

/** База API: перевизначення з підключення → тестовий хост → бойовий. */
export function baseUrlOf(
  conn: Pick<SupplierConnectionContext, 'apiUrl' | 'testMode'>,
  prod: string,
  test?: string,
): string {
  if (conn.apiUrl) return conn.apiUrl.replace(/\/+$/, '');
  if (conn.testMode && test) return test;
  return prod;
}

/** Обов'язкове поле кредів; немає — помилка авторизації (повтор не допоможе). */
export function requireCredential(
  conn: SupplierConnectionContext,
  key: string,
  provider: string,
): string {
  const v = conn.credentials[key];
  if (!v) throw new SupplierAuthError(provider, `${provider}: не задано «${key}» у даних доступу`);
  return v;
}

/** Параметри доставки нашого складу; немає — протокольна помилка (планувальник ловить раніше). */
export function warehouseOptions(
  conn: SupplierConnectionContext,
  warehouseId: string,
  provider: string,
): Record<string, string> {
  const opts = conn.options.warehouses?.[warehouseId];
  if (!opts) {
    throw new SupplierProtocolError(provider, `${provider}: немає параметрів доставки для складу`);
  }
  return opts;
}

export function asArray<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function str(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** Дата «YYYY-MM-DD» за Києвом (параметри дат у запитах постачальників). */
export const kyivYmdString = (d: Date): string => kyivYmd(d);
