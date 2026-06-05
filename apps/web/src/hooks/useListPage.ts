'use client';

import { useState, useCallback } from 'react';
import { useTableColumns, type ColumnDef } from './useTableColumns';
import { useDetailPanel } from './useDetailPanel';
import { useDetailPanelConfig } from './useDetailPanelConfig';
import { useSavedFilters } from './useSavedFilters';
import { useUiFeatures } from './useUiFeatures';
import { useColumnDrag } from './useColumnDrag';

export interface UseListPageOptions {
  defaultLimit?: number;
}

/**
 * Composable hook for list pages.
 * Bundles: pagination, showDeleted, tableColumns+drag, detailPanel+panelConfig,
 *          savedFilters, uiFeatures, activeSavedFilterId.
 *
 * Bulk select is intentionally NOT included — use useBulkIndeterminate(items)
 * separately after the data hook, so the items reference is stable.
 *
 * Generic TFilters types savedFilters correctly for SavedFiltersBar:
 *   const lp = useListPage<InvoiceFilters>('invoices', COLUMNS);
 *   // lp.savedFilters.saved is SavedFilter<InvoiceFilters>[]
 */
export function useListPage<TFilters extends Record<string, unknown> = Record<string, unknown>>(
  pageKey: string,
  columns: ColumnDef[],
  options?: UseListPageOptions,
) {
  const features = useUiFeatures();
  const [page, setPage] = useState(1);
  const [showDeleted, setShowDeleted] = useState(false);
  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);

  const tableColumns = useTableColumns(pageKey, columns);
  const { orderedColumns, visibleColumns } = tableColumns;
  const { dragProps } = useColumnDrag(visibleColumns, tableColumns.reorder, orderedColumns);
  const detailPanel = useDetailPanel(pageKey);
  const panelConfig = useDetailPanelConfig(`${pageKey}-panel`);
  const savedFilters = useSavedFilters<TFilters>(pageKey);

  const resetPage = useCallback(() => setPage(1), []);

  return {
    page,
    setPage,
    resetPage,
    showDeleted,
    setShowDeleted,
    activeSavedFilterId,
    setActiveSavedFilterId,
    tableColumns,
    dragProps,
    detailPanel,
    panelConfig,
    savedFilters,
    features,
    limit: options?.defaultLimit ?? 20,
  };
}
