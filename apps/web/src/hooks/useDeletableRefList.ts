import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache, type RefCacheKey } from '@/lib/ref-cache';

interface DeletableRefListOptions {
  /** Список лише активних записів — те, що лягає в кеш довідника. */
  url: string;
  /** Той самий список разом із видаленими (режим «Показати видалені»). */
  urlWithDeleted: string;
  cacheKey: RefCacheKey;
  showDeleted: boolean;
  setError: (message: string) => void;
  /** Текст помилки завантаження, коли відповідь не дала власного. */
  loadErrorText: string;
}

/**
 * Довідник із перемикачем «Показати видалені» поверх `sessionStorage`-кешу (`lib/ref-cache`).
 * Кеш тримає лише АКТИВНІ записи — його читають вибори в картках (бренд, статус), тож у режимі
 * з видаленими `load()` кеш не пише, а `reload()` після видалення / відновлення / правки
 * оновлює його окремим запитом: інакше вибір бренду бачив видалений бренд і не бачив відновленого.
 */
export function useDeletableRefList<T>({
  url,
  urlWithDeleted,
  cacheKey,
  showDeleted,
  setError,
  loadErrorText,
}: DeletableRefListOptions) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  // race-guard для швидких перемикань showDeleted — застарілу відповідь відкидаємо.
  const loadReqRef = useRef(0);

  const load = useCallback(
    (opts?: { fromCache?: boolean }) => {
      const cached = opts?.fromCache && !showDeleted ? getCached<T[]>(cacheKey) : null;
      if (cached) {
        setItems(cached);
        setLoading(false);
      } else setLoading(true);
      const reqId = ++loadReqRef.current;
      apiFetch<{ items: T[]; total: number }>(showDeleted ? urlWithDeleted : url)
        .then(r => {
          if (loadReqRef.current !== reqId) return;
          setItems(r.items);
          if (!showDeleted) setCache(cacheKey, r.items);
        })
        .catch((e: unknown) => {
          if (loadReqRef.current !== reqId) return;
          if (!cached) setError(e instanceof Error ? e.message : loadErrorText);
        })
        .finally(() => {
          if (loadReqRef.current === reqId) setLoading(false);
        });
    },
    [url, urlWithDeleted, cacheKey, showDeleted, setError, loadErrorText],
  );

  useEffect(() => {
    load({ fromCache: !showDeleted });
  }, [load, showDeleted]);

  const reload = useCallback(() => {
    load();
    if (showDeleted)
      void apiFetch<{ items: T[] }>(url)
        .then(r => setCache(cacheKey, r.items))
        .catch(() => undefined);
  }, [load, showDeleted, url, cacheKey]);

  return { items, loading, reload };
}
