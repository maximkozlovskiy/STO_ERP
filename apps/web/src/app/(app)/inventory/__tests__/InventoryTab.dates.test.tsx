// Дати відбору в розрізах залишків «По документах» / «По партіях» (optimize, цикл 3, 2026-10-09).
//
// Рідне поле дати під час набору року з клавіатури віддає кожну проміжну дату
// (0002-10-09 → 0020-10-09 → 0202-10-09 → 2026-10-09). Виміряно в браузері: без затримки це
// 4 запити `by-document` на одну набрану дату, з яких 3 зайві (і кожен «з року 2» тягне всю
// історію). У фільтр хука має піти лише усталене значення.
//
// Mutation-verify: повернути `from` / `to` замість `debouncedFrom` / `debouncedTo` у
// `viewFilters` → перші два кейси падають.

import { screen, fireEvent, act } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach, afterEach } from 'vitest';
import { renderWithQueryClient } from '@/__tests__/query-utils';

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

const renderTab = () => renderWithQueryClient(<InventoryTab />);
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

  it.each([
    ['По документах', 0, useStockByDocumentMock, 'from'],
    ['По партіях', 1, useStockByBatchMock, 'to'],
  ] as const)(
    '%s: набір року з клавіатури дає один запит із межею, а не чотири',
    (mode, index, mock, key) => {
      renderTab();
      fireEvent.click(screen.getByRole('button', { name: mode }));
      const input = dateInputs()[index]!;
      for (const value of TYPED_YEAR) {
        fireEvent.change(input, { target: { value } });
        tick(120);
      }
      // Поле показує набране одразу, запит ще чекає.
      expect(input).toHaveValue('2026-10-09');
      expect(distinct(mock, key)).toEqual([undefined]);
      tick(300);
      expect(distinct(mock, key)).toEqual([undefined, '2026-10-09']);
    },
  );

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
