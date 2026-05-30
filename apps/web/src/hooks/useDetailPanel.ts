'use client';

import { useState, useCallback, useEffect } from 'react';

/**
 * Manages detail panel enabled/open state.
 * - `enabled` persists in localStorage — remembers last user preference
 * - `open` is derived: panel shows only when enabled AND an item is selected
 */
export function useDetailPanel(storageKey: string) {
  const lsKey = `sto_detail_panel_${storageKey}`;

  const [enabled, setEnabled] = useState(true); // optimistic default

  // Hydrate from localStorage after mount (SSR-safe)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(lsKey);
      if (stored !== null) setEnabled(stored === 'true');
    } catch {
      /* ignore */
    }
  }, [lsKey]);

  const toggle = useCallback(() => {
    setEnabled(prev => {
      const next = !prev;
      try {
        window.localStorage.setItem(lsKey, String(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, [lsKey]);

  return { enabled, toggle };
}
