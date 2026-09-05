'use client';

import { useState, useCallback, useEffect } from 'react';

/** Знімок сортування таблиці для збереженого подання. */
export interface SavedSortState {
  field: string;
  dir: 'asc' | 'desc';
}

/**
 * Збережене «подання» списку. Історично називалось «фільтр», тому тип лишається
 * SavedFilter (back-compat зі старими localStorage-записами), але тепер може нести
 * повний знімок вигляду: фільтри + видимі колонки + порядок колонок + сортування.
 * Усі view-поля опційні — старі записи без них застосовуються як раніше.
 */
export interface SavedFilter<T extends Record<string, unknown>> {
  id: string;
  name: string;
  filters: T;
  createdAt: number;
  /** Ключі видимих колонок на момент збереження. */
  columns?: string[];
  /** Порядок колонок на момент збереження. */
  order?: string[];
  /** Сортування на момент збереження. */
  sort?: SavedSortState | null;
}

/** Додаткові view-поля, що передаються у save() поряд із фільтрами. */
export interface SavedViewExtra {
  columns?: string[];
  order?: string[];
  sort?: SavedSortState | null;
}

/**
 * Persists named filter presets to localStorage for a given page key.
 *
 * Usage:
 *   const { saved, save, remove, apply } = useSavedFilters<MyFilters>('work-orders');
 *   // save({ name: 'В роботі', filters: { status: 'IN_PROGRESS' } })
 *   // apply(preset) → calls onApply with preset.filters
 *
 * SSR-safety: initial state is always `[]` to match server render; localStorage
 * is read in an effect on mount to avoid hydration mismatch (server: empty,
 * client lazy initializer would otherwise return persisted array → mismatch).
 */
export function useSavedFilters<T extends Record<string, unknown>>(pageKey: string) {
  const storageKey = `sto_filters_${pageKey}`;

  const read = useCallback((): SavedFilter<T>[] => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      // Corruption defense: localStorage may have been overwritten by another
      // tab, devtools, or older app version with a non-array value. Bail to []
      // instead of crashing the page on .map().
      return Array.isArray(parsed) ? (parsed as SavedFilter<T>[]) : [];
    } catch {
      return [];
    }
  }, [storageKey]);

  // Always start with [] on both server and first client render to avoid
  // hydration mismatch; hydrate from localStorage in an effect post-mount.
  const [saved, setSaved] = useState<SavedFilter<T>[]>([]);

  useEffect(() => {
    setSaved(read());
  }, [read]);

  const save = useCallback(
    (name: string, filters: T, extra?: SavedViewExtra) => {
      const preset: SavedFilter<T> = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name,
        filters,
        createdAt: Date.now(),
        ...(extra?.columns ? { columns: extra.columns } : {}),
        ...(extra?.order ? { order: extra.order } : {}),
        ...(extra?.sort !== undefined ? { sort: extra.sort } : {}),
      };
      setSaved(prev => {
        const next = [...prev, preset];
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
      return preset;
    },
    [storageKey],
  );

  const remove = useCallback(
    (id: string) => {
      setSaved(prev => {
        const next = prev.filter(p => p.id !== id);
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [storageKey],
  );

  const rename = useCallback(
    (id: string, name: string) => {
      setSaved(prev => {
        const next = prev.map(p => (p.id === id ? { ...p, name } : p));
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [storageKey],
  );

  return { saved, save, remove, rename };
}
