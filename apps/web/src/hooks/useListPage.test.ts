import { act, renderHook } from '@testing-library/react';
import { it, expect, describe, vi } from 'vitest';

// Stub heavy hooks so useListPage can be tested without DOM/localStorage complexity
vi.mock('./useTableColumns', () => ({
  useTableColumns: () => ({
    visibleKeys: new Set(),
    visibleColumns: [],
    orderedColumns: [],
    order: [],
    customLabels: {},
    toggle: vi.fn(),
    reorder: vi.fn(),
    renameColumn: vi.fn(),
    resetConfig: vi.fn(),
  }),
}));
vi.mock('./useColumnDrag', () => ({
  useColumnDrag: () => ({ dragProps: {} }),
}));
vi.mock('./useDetailPanel', () => ({
  useDetailPanel: () => ({ enabled: false, toggle: vi.fn() }),
}));
vi.mock('./useDetailPanelConfig', () => ({
  useDetailPanelConfig: () => ({ config: {}, toggleField: vi.fn(), reset: vi.fn() }),
}));
vi.mock('./useSavedFilters', () => ({
  useSavedFilters: () => ({
    saved: [],
    save: vi.fn(() => ({ id: 'p1', name: 'test', filters: {}, createdAt: 0 })),
    remove: vi.fn(),
  }),
}));
vi.mock('./useUiFeatures', () => ({
  useUiFeatures: () => ({ toastEnabled: true, bulkActionsEnabled: true }),
}));

import { useListPage } from './useListPage';

const COLUMNS = [{ key: 'name', label: 'Name', defaultVisible: true }];

describe('useListPage', () => {
  it('повертає page=1 і showDeleted=false за замовчуванням', () => {
    const { result } = renderHook(() => useListPage('test', COLUMNS));
    expect(result.current.page).toBe(1);
    expect(result.current.showDeleted).toBe(false);
  });

  it('повертає limit з options або 20 за замовчуванням', () => {
    const { result: r1 } = renderHook(() => useListPage('test', COLUMNS));
    expect(r1.current.limit).toBe(20);

    const { result: r2 } = renderHook(() => useListPage('test', COLUMNS, { defaultLimit: 50 }));
    expect(r2.current.limit).toBe(50);
  });

  it('setPage оновлює page', () => {
    const { result } = renderHook(() => useListPage('test', COLUMNS));
    act(() => result.current.setPage(3));
    expect(result.current.page).toBe(3);
  });

  it('resetPage повертає page до 1', () => {
    const { result } = renderHook(() => useListPage('test', COLUMNS));
    act(() => result.current.setPage(5));
    expect(result.current.page).toBe(5);
    act(() => result.current.resetPage());
    expect(result.current.page).toBe(1);
  });

  // Bug #357 regression-guard: resetPage identity must remain stable across renders.
  // /simplify (41ed7b9) replaced setPage(1)→resetPage() inside applyFilter useCallback
  // bodies; /sync (a681c25) then updated dep arrays [setPage]→[resetPage]. The whole
  // chain only works if resetPage has a stable identity (useCallback with [] deps);
  // otherwise consumers' applyFilter would be re-created on every render → cascading
  // re-renders of <SavedFiltersBar onApply={applyFilter}> would invalidate React
  // child memoization (intended by the saved-filters refactor in commit 4f7a9be).
  it('resetPage identity стабільна між render-ами (для useCallback deps)', () => {
    const { result, rerender } = renderHook(() => useListPage('test', COLUMNS));
    const firstResetPage = result.current.resetPage;
    const firstSetPage = result.current.setPage;
    rerender();
    expect(result.current.resetPage).toBe(firstResetPage);
    expect(result.current.setPage).toBe(firstSetPage);
    // Also stable after state mutation (re-render triggered by setState)
    act(() => result.current.setPage(3));
    expect(result.current.resetPage).toBe(firstResetPage);
    act(() => result.current.resetPage());
    expect(result.current.resetPage).toBe(firstResetPage);
  });

  it('setShowDeleted перемикає showDeleted', () => {
    const { result } = renderHook(() => useListPage('test', COLUMNS));
    act(() => result.current.setShowDeleted(true));
    expect(result.current.showDeleted).toBe(true);
    act(() => result.current.setShowDeleted(false));
    expect(result.current.showDeleted).toBe(false);
  });

  it('activeSavedFilterId спочатку null', () => {
    const { result } = renderHook(() => useListPage('test', COLUMNS));
    expect(result.current.activeSavedFilterId).toBeNull();
  });

  it('setActiveSavedFilterId оновлює activeSavedFilterId', () => {
    const { result } = renderHook(() => useListPage('test', COLUMNS));
    act(() => result.current.setActiveSavedFilterId('filter-1'));
    expect(result.current.activeSavedFilterId).toBe('filter-1');
  });

  it('повертає tableColumns, dragProps, detailPanel, panelConfig, savedFilters, features', () => {
    const { result } = renderHook(() => useListPage('test', COLUMNS));
    expect(result.current.tableColumns).toBeDefined();
    expect(result.current.dragProps).toBeDefined();
    expect(result.current.detailPanel).toBeDefined();
    expect(result.current.panelConfig).toBeDefined();
    expect(result.current.savedFilters).toBeDefined();
    expect(result.current.features).toBeDefined();
  });

  it('різні pageKey не конфліктують між собою', () => {
    const { result: r1 } = renderHook(() => useListPage('page-a', COLUMNS));
    const { result: r2 } = renderHook(() => useListPage('page-b', COLUMNS));
    act(() => r1.current.setPage(2));
    // page-b залишається 1
    expect(r2.current.page).toBe(1);
    expect(r1.current.page).toBe(2);
  });
});
