'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '@/lib/api-client';
import {
  EMPTY_NAV_LAYOUT,
  newCustomSectionId,
  normalizeNavLayout,
  type NavLayout,
} from '@/lib/nav-layout';

const STORAGE_KEY = 'sto_nav_layout';
const TS_KEY = 'sto_nav_layout_ts';
const API_KEY = 'nav_layout';
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Per-user кастомізація бокової панелі — reorder / hide / кастомні розділи / перенесення.
 * Дзеркалить useDetailPanelConfig: user-preferences (key `nav_layout`) + localStorage-кеш (TTL 5хв),
 * configRef проти lost-update (два кліки в одному tick), abort-dedup PUT, offline-tolerant.
 */
export function useNavConfig() {
  const [layout, setLayout] = useState<NavLayout>(EMPTY_NAV_LAYOUT);
  const [loading, setLoading] = useState(true);

  // Найсвіжіший layout — мутатори читають звідси (не зі stale-замикання).
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const mountedRef = useRef(true);
  const putAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      putAbortRef.current?.abort();
      putAbortRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let skipFetch = false;
    try {
      const cached = localStorage.getItem(STORAGE_KEY);
      const ts = Number(localStorage.getItem(TS_KEY) ?? 0);
      if (cached) {
        setLayout(normalizeNavLayout(JSON.parse(cached)));
        if (Date.now() - ts < CACHE_TTL_MS) skipFetch = true;
      }
    } catch {
      /* ignore */
    }

    if (skipFetch) {
      setLoading(false);
      return;
    }

    apiFetch<{ key: string; value: unknown }>(`/user-preferences/${API_KEY}`)
      .then(res => {
        if (cancelled) return;
        const cfg = normalizeNavLayout(res.value);
        setLayout(cfg);
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
          localStorage.setItem(TS_KEY, String(Date.now()));
        } catch {
          /* ignore */
        }
      })
      .catch(() => {
        /* offline: використовуємо localStorage */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const savePref = useCallback((next: NavLayout) => {
    putAbortRef.current?.abort();
    const ac = new AbortController();
    putAbortRef.current = ac;
    try {
      localStorage.setItem(TS_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    apiFetch(`/user-preferences/${API_KEY}`, {
      method: 'PUT',
      body: JSON.stringify({ key: API_KEY, value: next }),
      signal: ac.signal,
    }).catch(() => {
      /* AbortError або мережа: тихо (offline-first) */
    });
  }, []);

  // Чистий commit: оновлює ref (синхронно, для чейну кліків) + state + localStorage + PUT.
  const commit = useCallback(
    (next: NavLayout) => {
      layoutRef.current = next;
      setLayout(next);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      savePref(next);
    },
    [savePref],
  );

  // Хелпер: застосувати мутацію до найсвіжішого layout.
  const mutate = useCallback(
    (fn: (cur: NavLayout) => NavLayout) => {
      commit(fn(layoutRef.current));
    },
    [commit],
  );

  const hideItem = useCallback(
    (href: string) =>
      mutate(cur =>
        cur.hiddenItems.includes(href) ? cur : { ...cur, hiddenItems: [...cur.hiddenItems, href] },
      ),
    [mutate],
  );

  const showItem = useCallback(
    (href: string) =>
      mutate(cur => ({ ...cur, hiddenItems: cur.hiddenItems.filter(h => h !== href) })),
    [mutate],
  );

  const toggleItem = useCallback(
    (href: string) =>
      mutate(cur =>
        cur.hiddenItems.includes(href)
          ? { ...cur, hiddenItems: cur.hiddenItems.filter(h => h !== href) }
          : { ...cur, hiddenItems: [...cur.hiddenItems, href] },
      ),
    [mutate],
  );

  const toggleSection = useCallback(
    (id: string) =>
      mutate(cur =>
        cur.hiddenSections.includes(id)
          ? { ...cur, hiddenSections: cur.hiddenSections.filter(s => s !== id) }
          : { ...cur, hiddenSections: [...cur.hiddenSections, id] },
      ),
    [mutate],
  );

  const reorderItems = useCallback(
    (sectionId: string, order: string[]) =>
      mutate(cur => ({ ...cur, itemOrder: { ...cur.itemOrder, [sectionId]: order } })),
    [mutate],
  );

  /** Переносить пункт у секцію і ставить у кінець її itemOrder. */
  const moveItemToSection = useCallback(
    (href: string, sectionId: string, targetOrder?: string[]) =>
      mutate(cur => {
        const prevOrder = cur.itemOrder[sectionId] ?? [];
        const nextOrder = targetOrder ?? [...prevOrder.filter(h => h !== href), href];
        // Прибираємо href з itemOrder інших секцій (щоб не лишався привид).
        const cleanedOrder: Record<string, string[]> = {};
        for (const [sec, arr] of Object.entries(cur.itemOrder)) {
          if (sec === sectionId) continue;
          cleanedOrder[sec] = arr.filter(h => h !== href);
        }
        return {
          ...cur,
          itemSection: { ...cur.itemSection, [href]: sectionId },
          itemOrder: { ...cleanedOrder, [sectionId]: nextOrder },
        };
      }),
    [mutate],
  );

  const reorderSections = useCallback(
    (order: string[]) => mutate(cur => ({ ...cur, sectionOrder: order })),
    [mutate],
  );

  const addSection = useCallback(
    (label: string): string => {
      const id = newCustomSectionId();
      mutate(cur => ({
        ...cur,
        customSections: [...cur.customSections, { id, label: label.trim() || 'Новий розділ' }],
        sectionOrder: cur.sectionOrder.length ? [...cur.sectionOrder, id] : [],
      }));
      return id;
    },
    [mutate],
  );

  const renameSection = useCallback(
    (id: string, label: string) =>
      mutate(cur => ({
        ...cur,
        customSections: cur.customSections.map(s => (s.id === id ? { ...s, label } : s)),
      })),
    [mutate],
  );

  /** Видаляє кастомний розділ: його пункти повертаються у дефолтні (прибираємо itemSection-overrides). */
  const removeSection = useCallback(
    (id: string) =>
      mutate(cur => {
        const itemSection: Record<string, string> = {};
        for (const [href, sec] of Object.entries(cur.itemSection)) {
          if (sec !== id) itemSection[href] = sec;
        }
        const itemOrder: Record<string, string[]> = {};
        for (const [sec, arr] of Object.entries(cur.itemOrder)) {
          if (sec !== id) itemOrder[sec] = arr;
        }
        return {
          ...cur,
          customSections: cur.customSections.filter(s => s.id !== id),
          hiddenSections: cur.hiddenSections.filter(s => s !== id),
          sectionOrder: cur.sectionOrder.filter(s => s !== id),
          itemSection,
          itemOrder,
        };
      }),
    [mutate],
  );

  const reset = useCallback(() => {
    layoutRef.current = EMPTY_NAV_LAYOUT;
    if (mountedRef.current) setLayout(EMPTY_NAV_LAYOUT);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    savePref(EMPTY_NAV_LAYOUT);
  }, [savePref]);

  return {
    layout,
    loading,
    hideItem,
    showItem,
    toggleItem,
    toggleSection,
    reorderItems,
    moveItemToSection,
    reorderSections,
    addSection,
    renameSection,
    removeSection,
    reset,
  };
}
