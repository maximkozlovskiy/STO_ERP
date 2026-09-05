import { useState, useCallback, useMemo, useEffect } from 'react';

export interface ColumnDef {
  key: string;
  label: string;
  defaultVisible?: boolean;
}

const LS_VISIBLE = (k: string) => `sto_columns_${k}`;
const LS_ORDER = (k: string) => `sto_col_order_${k}`;
const LS_LABELS = (k: string) => `sto_col_labels_${k}`;

function readOrder(pageKey: string, defaultKeys: string[]): string[] {
  try {
    const raw = window.localStorage.getItem(LS_ORDER(pageKey));
    if (!raw) return defaultKeys;
    const stored: unknown = JSON.parse(raw);
    if (Array.isArray(stored) && stored.every(x => typeof x === 'string')) {
      const storedArr = stored as string[];
      const set = new Set(defaultKeys);
      const ordered = storedArr.filter(k => set.has(k));
      defaultKeys.filter(k => !ordered.includes(k)).forEach(k => ordered.push(k));
      return ordered;
    }
  } catch {
    /* ignore */
  }
  return defaultKeys;
}

function readLabels(pageKey: string): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(LS_LABELS(pageKey));
    if (!raw) return {};
    const stored: unknown = JSON.parse(raw);
    if (stored && typeof stored === 'object' && !Array.isArray(stored))
      return stored as Record<string, string>;
  } catch {
    /* ignore */
  }
  return {};
}

export function useTableColumns(pageKey: string, columns: ColumnDef[]) {
  const defaultKeys = useMemo(() => columns.map(c => c.key), [columns]);

  // Visible keys — hydrated from localStorage after mount
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(
    () => new Set(columns.filter(c => c.defaultVisible !== false).map(c => c.key)),
  );

  // Column order — hydrated from localStorage after mount
  const [order, setOrder] = useState<string[]>(defaultKeys);

  // Custom labels — hydrated from localStorage after mount
  const [customLabels, setCustomLabels] = useState<Record<string, string>>({});

  // Hydrate all three from localStorage on mount (SSR-safe)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(LS_VISIBLE(pageKey));
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string'))
          setVisibleKeys(new Set(parsed as string[]));
      }
    } catch {
      /* ignore */
    }
    setOrder(readOrder(pageKey, defaultKeys));
    setCustomLabels(readLabels(pageKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey]);

  // Re-sync order when ColumnsDropdown saves (storage event from same tab)
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === LS_ORDER(pageKey)) setOrder(readOrder(pageKey, defaultKeys));
      if (e.key === LS_LABELS(pageKey)) setCustomLabels(readLabels(pageKey));
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, [pageKey, defaultKeys]);

  // Toggle visibility and persist
  const toggle = useCallback(
    (key: string) => {
      setVisibleKeys(prev => {
        const next = new Set(prev);
        if (next.has(key)) {
          if (next.size <= 1) return prev;
          next.delete(key);
        } else {
          next.add(key);
        }
        try {
          window.localStorage.setItem(LS_VISIBLE(pageKey), JSON.stringify([...next]));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [pageKey],
  );

  // Bulk-set visible columns and persist — used коли застосовуємо збережене
  // «подання» (Saved View), що несе повний набір видимих колонок за раз.
  // Ігнорує ключі, яких немає у defaultKeys (back-compat зі старими подання),
  // і не дозволяє порожній набір (лишає попередній, як і toggle).
  const setVisible = useCallback(
    (keys: string[]) => {
      const known = new Set(defaultKeys);
      const filtered = keys.filter(k => known.has(k));
      if (filtered.length === 0) return;
      const next = new Set(filtered);
      setVisibleKeys(next);
      try {
        window.localStorage.setItem(LS_VISIBLE(pageKey), JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
    },
    [pageKey, defaultKeys],
  );

  // Reorder and persist — called by ColumnsDropdown after drag
  const reorder = useCallback(
    (newOrder: string[]) => {
      setOrder(newOrder);
      try {
        window.localStorage.setItem(LS_ORDER(pageKey), JSON.stringify(newOrder));
      } catch {
        /* ignore */
      }
    },
    [pageKey],
  );

  // Update label and persist — called by ColumnsDropdown after rename
  const renameColumn = useCallback(
    (key: string, label: string | null) => {
      setCustomLabels(prev => {
        const next = { ...prev };
        if (label === null) delete next[key];
        else next[key] = label;
        try {
          window.localStorage.setItem(LS_LABELS(pageKey), JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [pageKey],
  );

  // Reset all customization
  const resetConfig = useCallback(() => {
    setOrder(defaultKeys);
    setCustomLabels({});
    try {
      window.localStorage.removeItem(LS_ORDER(pageKey));
      window.localStorage.removeItem(LS_LABELS(pageKey));
    } catch {
      /* ignore */
    }
  }, [pageKey, defaultKeys]);

  const isVisible = useCallback((key: string) => visibleKeys.has(key), [visibleKeys]);

  // Columns in user-defined order, with custom labels applied
  const orderedColumns = useMemo(
    () =>
      [...columns]
        .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
        .map(c => ({ ...c, label: customLabels[c.key] ?? c.label })),
    [columns, order, customLabels],
  );

  // Only visible columns in order
  const visibleColumns = useMemo(
    () => orderedColumns.filter(c => visibleKeys.has(c.key)),
    [orderedColumns, visibleKeys],
  );

  return {
    visibleKeys,
    visibleColumns,
    orderedColumns,
    order,
    customLabels,
    toggle,
    setVisible,
    reorder,
    renameColumn,
    resetConfig,
    isVisible,
  };
}
