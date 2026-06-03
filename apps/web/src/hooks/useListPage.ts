'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useBulkSelect } from './useBulkSelect';
import { useTableColumns, type ColumnDef } from './useTableColumns';
import { useDetailPanel } from './useDetailPanel';
import { useDetailPanelConfig } from './useDetailPanelConfig';
import { useSavedFilters } from './useSavedFilters';
import { useUiFeatures } from './useUiFeatures';

export interface UseListPageOptions<T extends { id: string }> {
  defaultLimit?: number;
  /**
   * Visible rows on the current page. Used by `useBulkSelect` to (a) compute
   * select-all/some-selected state and (b) prune stale IDs when the page or
   * filter changes. Must be a stable reference per render — pass the array
   * returned by the data hook (`data?.items ?? EMPTY`) rather than a literal
   * `[]`, otherwise the bulk-select effect fires on every render.
   */
  items?: readonly T[];
}

// Stable empty fallback — avoids a fresh array each render when caller has no items yet.
const EMPTY: readonly { id: string }[] = Object.freeze([]);

export function useListPage<T extends { id: string }>(
  pageKey: string,
  columns: ColumnDef[],
  options?: UseListPageOptions<T>,
) {
  const features = useUiFeatures();
  const [page, setPage] = useState(1);
  const [showDeleted, setShowDeleted] = useState(false);

  const items = (options?.items ?? (EMPTY as readonly T[])) as T[];
  const bulkSelect = useBulkSelect<T>(items);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = bulkSelect.someSelected;
  }, [bulkSelect.someSelected]);

  const tableColumns = useTableColumns(pageKey, columns);
  const detailPanel = useDetailPanel(pageKey);
  const panelConfig = useDetailPanelConfig(`${pageKey}-panel`);
  const savedFilters = useSavedFilters(pageKey);

  const resetPage = useCallback(() => setPage(1), []);

  return {
    page,
    setPage,
    resetPage,
    showDeleted,
    setShowDeleted,
    bulkSelect,
    selectAllRef,
    tableColumns,
    detailPanel,
    panelConfig,
    savedFilters,
    features,
    limit: options?.defaultLimit ?? 20,
  };
}
