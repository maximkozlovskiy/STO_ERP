// Дати відбору в розрізах залишків «По документах» / «По партіях» (рішення власника 2026-10-09).
//
// Поля — спільний `DateRangeFilter`, а не рідне `type="date"`: рідне поле під час набору року
// віддавало кожну проміжну дату (0002-10-09 → 0020-10-09 → 0202-10-09 → 2026-10-09) — 4 запити
// `by-document` на одну набрану дату, а рік із 5 цифр давав 400 зі старими даними на екрані.
// Спільне поле віддає у фільтр лише завершену дату.
//
// Збій запиту розрізу показує смугу з «Повторити», а не порожню таблицю.
//
// Mutation-verify: повернути `<Input type="date">` → кейси «недописана дата» падають (поля з
// назвою «З» / «По» немає); прибрати `ListLoadError` → кейс помилки падає.

import { screen, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
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

const renderTab = () => renderWithQueryClient(<InventoryTab />);
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
/** Різні значення межі, з якими хук розрізу викликали (кожне нове = окремий запит). */
const distinct = (mock: typeof useStockByDocumentMock, key: keyof Filters) => [
  ...new Set(mock.mock.calls.map(c => (c[0] as Filters)[key])),
];

describe('InventoryTab — дати розрізів залишків', () => {
  beforeEach(() => {
    useStockByDocumentMock.mockReset().mockReturnValue({ data: { goods: [] }, isLoading: false });
    useStockByBatchMock.mockReset().mockReturnValue({ data: { batches: [] }, isLoading: false });
  });

  it.each([
    ['По документах', 'З', useStockByDocumentMock, 'from'],
    ['По партіях', 'По', useStockByBatchMock, 'to'],
  ] as const)(
    '%s: недописана дата запиту не дає, завершена — один запит із межею',
    (mode, label, mock, key) => {
      renderTab();
      fireEvent.click(screen.getByRole('button', { name: mode }));
      for (const partial of ['0', '09.1', '09.10.2', '09.10.202']) type(label, partial);
      expect(distinct(mock, key)).toEqual([undefined]);
      type(label, '09.10.2026');
      expect(distinct(mock, key)).toEqual([undefined, '2026-10-09']);
    },
  );

  it('очищене поле знімає межу з запиту', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'По документах' }));
    type('З', '09.10.2026');
    expect((useStockByDocumentMock.mock.lastCall![0] as Filters).from).toBe('2026-10-09');
    type('З', '');
    expect((useStockByDocumentMock.mock.lastCall![0] as Filters).from).toBeUndefined();
  });

  it('у режимі «По товарах» полів дат немає', () => {
    renderTab();
    expect(screen.queryByLabelText('З')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('По')).not.toBeInTheDocument();
  });

  it('збій запиту розрізу — смуга з текстом помилки і «Повторити», що перезапитує', () => {
    const refetch = vi.fn();
    useStockByDocumentMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error('Забагато запитів'),
      refetch,
    });
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'По документах' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Забагато запитів');
    fireEvent.click(screen.getByRole('button', { name: 'Повторити' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
