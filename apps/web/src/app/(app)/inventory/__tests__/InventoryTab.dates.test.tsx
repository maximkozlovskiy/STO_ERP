// Дати відбору в розрізах залишків «По документах» / «По партіях» (optimize, цикл 3, 2026-10-09).
//
// Рідне поле дати під час набору року з клавіатури віддає кожну проміжну дату
// (0002-10-09 → 0020-10-09 → 0202-10-09 → 2026-10-09). Виміряно в браузері: без затримки це
// 4 запити `by-document` на одну набрану дату, з яких 3 зайві (і кожен «з року 2» тягне всю
// історію). У фільтр хука має піти лише усталене значення.
//
// Mutation-verify: повернути `from` / `to` замість `debouncedFrom` / `debouncedTo` у
// `viewFilters` → перші два кейси падають.

import { render, screen, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve([])),
}));

const useStockByDocumentMock = vi.fn();
const useStockByBatchMock = vi.fn();
vi.mock('@/hooks/api/useInventory', () => ({
  inventoryKeys: { all: ['inventory'] },
  useStockItems: () => ({ data: [], isLoading: false, error: null }),
  useLowStockItems: () => ({ data: [], refetch: vi.fn() }),
  useStockByDocument: (...a: unknown[]) => useStockByDocumentMock(...a),
  useStockByBatch: (...a: unknown[]) => useStockByBatchMock(...a),
}));

import { InventoryTab } from '../InventoryTab';

type Filters = { from?: string; to?: string };
const TYPED_YEAR = ['0002-10-09', '0020-10-09', '0202-10-09', '2026-10-09'];

const renderTab = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <InventoryTab />
    </QueryClientProvider>,
  );
const dateInputs = () =>
  Array.from(document.querySelectorAll<HTMLInputElement>('input[type="date"]'));
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
/** Різні значення межі, з якими хук розрізу викликали (кожне нове = окремий запит). */
const distinct = (mock: typeof useStockByDocumentMock, key: keyof Filters) => [
  ...new Set(mock.mock.calls.map(c => (c[0] as Filters)[key])),
];

describe('InventoryTab — дати розрізів залишків ідуть у запит після затримки', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStockByDocumentMock.mockReset().mockReturnValue({ data: { goods: [] }, isLoading: false });
    useStockByBatchMock.mockReset().mockReturnValue({ data: { batches: [] }, isLoading: false });
  });
  afterEach(() => vi.useRealTimers());

  it('набір року з клавіатури дає один запит «з дня», а не чотири', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'По документах' }));
    const [from] = dateInputs();
    for (const value of TYPED_YEAR) {
      fireEvent.change(from!, { target: { value } });
      tick(120);
    }
    // Поле показує набране одразу, запит ще чекає.
    expect(from).toHaveValue('2026-10-09');
    expect(distinct(useStockByDocumentMock, 'from')).toEqual([undefined]);
    tick(300);
    expect(distinct(useStockByDocumentMock, 'from')).toEqual([undefined, '2026-10-09']);
  });

  it('те саме для межі «по день» у розрізі за партіями', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'По партіях' }));
    const [, to] = dateInputs();
    for (const value of TYPED_YEAR) {
      fireEvent.change(to!, { target: { value } });
      tick(120);
    }
    tick(300);
    expect(distinct(useStockByBatchMock, 'to')).toEqual([undefined, '2026-10-09']);
  });

  it('очищене поле знімає межу з запиту', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'По документах' }));
    const [from] = dateInputs();
    fireEvent.change(from!, { target: { value: '2026-10-09' } });
    tick(300);
    fireEvent.change(from!, { target: { value: '' } });
    tick(300);
    expect((useStockByDocumentMock.mock.lastCall![0] as Filters).from).toBeUndefined();
  });
});
