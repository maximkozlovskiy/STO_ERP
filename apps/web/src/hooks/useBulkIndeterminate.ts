'use client';

import { useRef, useEffect } from 'react';
import { useBulkSelect } from './useBulkSelect';

/**
 * Combines useBulkSelect with the indeterminate-checkbox ref pattern.
 * Replaces the 5-line boilerplate repeated across every list page:
 *   const bulkSelect = useBulkSelect(items);
 *   const selectAllRef = useRef<HTMLInputElement | null>(null);
 *   useEffect(() => {
 *     if (selectAllRef.current) selectAllRef.current.indeterminate = bulkSelect.someSelected;
 *   }, [bulkSelect.someSelected]);
 */
export function useBulkIndeterminate<T extends { id: string }>(items: readonly T[]) {
  const bulkSelect = useBulkSelect(items as T[]);
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = bulkSelect.someSelected;
    }
  }, [bulkSelect.someSelected]);

  return { ...bulkSelect, selectAllRef };
}
