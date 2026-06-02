'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useBulkSelect } from './useBulkSelect';
import { useTableColumns, type ColumnDef } from './useTableColumns';
import { useDetailPanel } from './useDetailPanel';
import { useDetailPanelConfig } from './useDetailPanelConfig';
import { useSavedFilters } from './useSavedFilters';
import { useUiFeatures } from './useUiFeatures';

export interface UseListPageOptions {
  defaultLimit?: number;
}

export function useListPage<T extends { id: string }>(
  pageKey: string,
  columns: ColumnDef[],
  options?: UseListPageOptions,
) {
  const features = useUiFeatures();
  const [page, setPage] = useState(1);
  const [showDeleted, setShowDeleted] = useState(false);

  const bulkSelect = useBulkSelect<T>([]);
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
