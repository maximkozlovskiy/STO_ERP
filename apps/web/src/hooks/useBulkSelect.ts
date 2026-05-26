'use client';

import { useState, useCallback, useEffect } from 'react';

/**
 * Manages a set of selected row IDs for bulk actions.
 *
 * Stale-Set guard: when the `items` array changes (page navigation, filter
 * change, refetch), any previously-selected IDs that are no longer present
 * in the visible list are pruned. Without this, a user could select rows on
 * page 1, navigate to page 2, and have the bulk-actions bar still show
 * "Обрано: 5" while operating on invisible IDs.
 */
export function useBulkSelect<T extends { id: string }>(items: T[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Prune selected IDs that are no longer present in `items`.
  // Keeping the Set in sync with the visible page prevents:
  //   - "Обрано: N" counter showing invisible rows
  //   - allSelected/someSelected returning misleading states
  //   - bulk actions firing against IDs the user can't see
  useEffect(() => {
    const visibleIds = new Set(items.map(i => i.id));
    setSelected(prev => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      prev.forEach(id => {
        if (visibleIds.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : prev;
    });
  }, [items]);

  const toggle = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected(prev => {
      if (prev.size === items.length && items.length > 0) return new Set();
      return new Set(items.map(i => i.id));
    });
  }, [items]);

  const clear = useCallback(() => setSelected(new Set()), []);

  const isSelected = useCallback((id: string) => selected.has(id), [selected]);
  const allSelected = items.length > 0 && selected.size === items.length;
  const someSelected = selected.size > 0 && !allSelected;

  return { selected, toggle, toggleAll, clear, isSelected, allSelected, someSelected, count: selected.size };
}
