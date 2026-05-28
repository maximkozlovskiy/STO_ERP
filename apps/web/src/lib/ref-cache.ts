/**
 * sessionStorage cache for reference data (branches, warehouses, employees,
 * work-categories, payment-methods, brands, units, suppliers, lifts, zones).
 *
 * Reference data rarely changes within a session and is loaded as filters /
 * selects on many pages. Caching it in sessionStorage avoids re-fetching the
 * same lists on every page visit, cutting page-load network round-trips.
 *
 * Pattern on a page:
 *   const cached = getCached<Branch[]>('cache:branches');
 *   if (cached) { setBranches(cached); }
 *   apiFetch<Branch[]>('/branches').then(bs => { setBranches(bs); setCache('cache:branches', bs); });
 *
 * sessionStorage (not localStorage) so the cache is cleared when the tab closes
 * — keeps reference data reasonably fresh without an explicit invalidation layer.
 */

export type RefCacheKey =
  | 'cache:branches'
  | 'cache:warehouses'
  | 'cache:employees'
  | 'cache:work-categories'
  | 'cache:payment-methods'
  | 'cache:brands'
  | 'cache:units'
  | 'cache:suppliers'
  | 'cache:lifts'
  | 'cache:zones'
  | 'cache:wo-templates'
  | 'cache:currencies'
  | 'cache:bank-accounts';

export function getCached<T>(key: RefCacheKey): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function setCache(key: RefCacheKey, data: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(data));
  } catch {
    /* quota exceeded / disabled storage — caching is best-effort */
  }
}
