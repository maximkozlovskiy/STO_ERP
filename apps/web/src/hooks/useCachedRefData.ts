'use client';

import { useState, useEffect, useRef } from 'react';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache, type RefCacheKey } from '@/lib/ref-cache';

interface UseCachedRefDataResult<T> {
  data: T;
  loading: boolean;
  error: string;
}

/**
 * Loads reference data with sessionStorage caching.
 *
 * Replaces the ~25-line pattern repeated across 5+ pages:
 *   const cached = getCached('cache:X');
 *   if (cached) setState(cached);
 *   apiFetch('/endpoint').then(d => { setState(d); setCache('cache:X', d); });
 *
 * - Shows stale data immediately from cache, then refreshes in background.
 * - AbortController cancels the in-flight request on unmount.
 * - `loading` is false when stale data is already available from cache.
 *
 * Usage:
 *   const { data: branches } = useCachedRefData<Branch[]>('cache:branches', '/branches', []);
 *   const { data: brands, loading } = useCachedRefData('cache:brands', '/brands?limit=200', []);
 *
 * For endpoints that return `{ items: T[] }` use a transform:
 *   useCachedRefData('cache:brands', '/brands?limit=200', [], d => (d as any).items ?? d)
 */
export function useCachedRefData<T>(
  cacheKey: RefCacheKey,
  endpoint: string,
  fallback: T,
  transform?: (raw: unknown) => T,
): UseCachedRefDataResult<T> {
  // sto-optimize: share initial cache read across data + loading useState pair.
  // Раніше lazy init викликав getCached() ДВІЧІ на mount — sessionStorage.getItem + JSON.parse
  // виконувались двічі для одного й того ж ключа (для великих cached lists 200+ items
  // це непотрібний main thread block). Однократний read у useRef → обидва useState
  // переюзують той самий результат.
  const initialCacheRef = useRef<T | null | undefined>(undefined);
  const readCacheOnce = (): T | null => {
    if (initialCacheRef.current === undefined) {
      initialCacheRef.current = getCached<T>(cacheKey);
    }
    return initialCacheRef.current;
  };
  const [data, setData] = useState<T>(() => readCacheOnce() ?? fallback);
  const [loading, setLoading] = useState<boolean>(() => readCacheOnce() === null);
  const [error, setError] = useState('');

  useEffect(() => {
    const ac = new AbortController();

    apiFetch<unknown>(endpoint, { signal: ac.signal })
      .then(raw => {
        if (ac.signal.aborted) return;
        const value = transform ? transform(raw) : (raw as T);
        setData(value);
        setCache(cacheKey, value);
        setError('');
      })
      .catch(e => {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : 'Помилка завантаження');
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });

    return () => ac.abort();
    // endpoint and cacheKey are stable strings — intentionally no re-fetch on change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { data, loading, error };
}
