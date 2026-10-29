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
  // Зміна фільтра: інший набір рядків — з першої сторінки, і подання вже не «активне».
  const changeFilter = useCallback((apply: () => void) => {
    apply();
    setPage(1);
    setActiveSavedFilterId(null);
  }, []);
  // Обробник поля фільтра: `onChange={filterSetter(setSearch)}` — нове значення + `changeFilter`.
  const filterSetter = useCallback(
    <T>(set: (value: T) => void) =>
      (value: T) =>
        changeFilter(() => set(value)),
    [changeFilter],
  );
  // «Показати/сховати видалені»: інший набір рядків — з першої сторінки, без активного подання.
  const toggleShowDeleted = useCallback(() => {
    setShowDeleted(d => !d);
    setPage(1);
    setActiveSavedFilterId(null);
  }, []);

  return {
    page,
    setPage,
    resetPage,
    showDeleted,
    setShowDeleted,
    toggleShowDeleted,
    changeFilter,
    filterSetter,
    activeSavedFilterId,
    setActiveSavedFilterId,
    tableColumns,
    visibleColumns,
    // Ширина рядка «завантаження / порожньо»: колонки даних + дії рядка (+ прапорець вибору).
    colSpan: visibleColumns.length + (features.bulkActionsEnabled ? 2 : 1),
    dragProps,
    detailPanel,
    panelConfig,
    savedFilters,
    features,
    limit: options?.defaultLimit ?? 20,
  };
}
