import { useState, useCallback, useMemo } from 'react';

export interface ColumnDef {
  key: string;
  label: string;
  defaultVisible?: boolean;
}

export function useTableColumns(pageKey: string, columns: ColumnDef[]) {
  const storageKey = `sto_columns_${pageKey}`;

  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        if (Array.isArray(parsed)) return new Set(parsed as string[]);
      }
    } catch {
      // ignore
    }
    return new Set(columns.filter(c => c.defaultVisible !== false).map(c => c.key));
  });

  const toggle = useCallback((key: string) => {
    setVisibleKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size <= 1) return prev; // keep at least one column
        next.delete(key);
      } else {
        next.add(key);
      }
      try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* ignore */ }
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
