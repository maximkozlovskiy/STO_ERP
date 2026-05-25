'use client';

import { useState, useCallback, useEffect } from 'react';

export interface SavedFilter<T extends Record<string, unknown>> {
  id: string;
  name: string;
  filters: T;
  createdAt: number;
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
      return raw ? (JSON.parse(raw) as SavedFilter<T>[]) : [];
    } catch { return []; }
  }, [storageKey]);

  // Always start with [] on both server and first client render to avoid
  // hydration mismatch; hydrate from localStorage in an effect post-mount.
  const [saved, setSaved] = useState<SavedFilter<T>[]>([]);

  useEffect(() => {
    setSaved(read());
  }, [read]);

  const save = useCallback((name: string, filters: T) => {
    const preset: SavedFilter<T> = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      filters,
      createdAt: Date.now(),
    };
    setSaved(prev => {
      const next = [...prev, preset];
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    return preset;
  }, [storageKey]);

  const remove = useCallback((id: string) => {
    setSaved(prev => {
      const next = prev.filter(p => p.id !== id);
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, [storageKey]);

  const rename = useCallback((id: string, name: string) => {
    setSaved(prev => {
      const next = prev.map(p => p.id === id ? { ...p, name } : p);
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, [storageKey]);

  return { saved, save, remove, rename };
}
