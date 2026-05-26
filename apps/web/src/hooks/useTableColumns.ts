import { useState, useCallback, useMemo, useEffect } from 'react';

export interface ColumnDef {
  key: string;
  label: string;
  defaultVisible?: boolean;
}

export function useTableColumns(pageKey: string, columns: ColumnDef[]) {
  const storageKey = `sto_columns_${pageKey}`;

  // Initialize from defaults only — `localStorage` is unavailable during SSR/static-export prerender,
  // and reading it inside `useState` initializer would also create a hydration mismatch (server set ≠ client set).
  // The hydration-safe pattern is: render defaults first, then hydrate from storage in an effect.
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(
    () => new Set(columns.filter(c => c.defaultVisible !== false).map(c => c.key)),
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (!stored) return;
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string')) {
        setVisibleKeys(new Set(parsed as string[]));
      }
    } catch {
      // ignore corruption — defaults remain in effect
    }
  }, [storageKey]);

  const toggle = useCallback((key: string) => {
    setVisibleKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size <= 1) return prev; // keep at least one column
        next.delete(key);
      } else {
        next.add(key);
      }
      if (typeof window !== 'undefined') {
        try { window.localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* ignore */ }
      }
      return next;
    });
  }, [storageKey]);

  const isVisible = useCallback((key: string) => visibleKeys.has(key), [visibleKeys]);

  const visibleColumns = useMemo(
    () => columns.filter(c => visibleKeys.has(c.key)),
    [columns, visibleKeys],
  );

  return { visibleKeys, visibleColumns, toggle, isVisible };
}
