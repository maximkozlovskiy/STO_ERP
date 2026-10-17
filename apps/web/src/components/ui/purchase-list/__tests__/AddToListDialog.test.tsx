// «До списку купівлі» (BR-PL-003): кількість за замовчуванням — непокрита потреба; рядки різних
// нарядів надсилаються по наряду, і перший запит створює список, у який іде решта; без вибраного
// рядка й з нульовою кількістю запит не йде.

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const fromWorkOrder = vi.fn();
vi.mock('@/hooks/api/usePurchaseLists', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/usePurchaseLists')>();
  return {
    ...actual,
    usePurchaseLists: () => ({
      data: {
        items: [{ id: 'l-open', number: 'СК-2026-000007', name: 'Тиждень', status: 'OPEN' }],
        total: 1,
      },
    }),
    purchaseListsApi: {
      ...actual.purchaseListsApi,
      fromWorkOrder: (b: unknown) => fromWorkOrder(b),
    },
  };
});
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AddToListDialog, type AddToListRow } from '../AddToListDialog';

const ROWS: AddToListRow[] = [
  { workOrderId: 'wo-1', workOrderPartId: 'p-1', label: 'Фільтр', shortage: 2, unit: 'шт' },
  { workOrderId: 'wo-2', workOrderPartId: 'p-2', label: 'Колодки', shortage: 1.5, unit: 'шт' },
];

function renderDialog(rows = ROWS, onDone = vi.fn(), onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AddToListDialog open rows={rows} onClose={onClose} onDone={onDone} />
    </QueryClientProvider>,
  );
  return { onDone, onClose };
}

describe('AddToListDialog', () => {
  beforeEach(() => {
    fromWorkOrder.mockReset();
  });

  // guards: BR-PL-003
  it('кількість за замовчуванням — непокрита потреба кожного рядка', () => {
    renderDialog();
    expect(screen.getByLabelText('Кількість для Фільтр')).toHaveValue(2);
    expect(screen.getByLabelText('Кількість для Колодки')).toHaveValue(1.5);
  });

  // guards: BR-PL-003
  it('два наряди → два запити: перший створює список, другий іде в нього', async () => {
    fromWorkOrder
      .mockResolvedValueOnce({ list: { id: 'l-new', number: 'СК-2026-000008' }, items: [{}] })
      .mockResolvedValueOnce({ list: { id: 'l-new', number: 'СК-2026-000008' }, items: [{}] });
    const { onDone, onClose } = renderDialog();
    fireEvent.change(screen.getByLabelText('Назва нового списку'), {
      target: { value: 'Терміново' },
    });
    fireEvent.change(screen.getByLabelText('Кількість для Фільтр'), { target: { value: '3' } });

    fireEvent.click(screen.getByRole('button', { name: 'Додати до списку' }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(fromWorkOrder.mock.calls).toEqual([
      [
        {
          workOrderId: 'wo-1',
          newList: { name: 'Терміново' },
          parts: [{ workOrderPartId: 'p-1', quantity: 3 }],
        },
      ],
      [
        {
          workOrderId: 'wo-2',
          listId: 'l-new',
          parts: [{ workOrderPartId: 'p-2', quantity: 1.5 }],
        },
      ],
    ]);
    expect(onDone).toHaveBeenCalledWith({
      listId: 'l-new',
      listNumber: 'СК-2026-000008',
      count: 2,
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('наявний список: запит із listId; без вибраного списку — помилка, запиту немає', async () => {
    fromWorkOrder.mockResolvedValue({
      list: { id: 'l-open', number: 'СК-2026-000007' },
      items: [{}],
    });
    renderDialog([ROWS[0]!]);
    fireEvent.click(screen.getByLabelText('Наявний відкритий список'));
    fireEvent.click(screen.getByRole('button', { name: 'Додати до списку' }));
    expect(await screen.findByText('Оберіть список')).toBeInTheDocument();
    expect(fromWorkOrder).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Список'), { target: { value: 'l-open' } });
    fireEvent.click(screen.getByRole('button', { name: 'Додати до списку' }));
    await waitFor(() => expect(fromWorkOrder).toHaveBeenCalledTimes(1));
    expect(fromWorkOrder.mock.calls[0]![0]).toMatchObject({
      workOrderId: 'wo-1',
      listId: 'l-open',
    });
  });

  it('нульова кількість або жодного рядка → помилка без запиту', async () => {
    renderDialog([ROWS[0]!]);
    fireEvent.change(screen.getByLabelText('Кількість для Фільтр'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Додати до списку' }));
    expect(await screen.findByText('Кількість має бути більшою за 0')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Вибрати Фільтр'));
    fireEvent.click(screen.getByRole('button', { name: 'Додати до списку' }));
    expect(await screen.findByText('Оберіть хоча б один товар')).toBeInTheDocument();
    expect(fromWorkOrder).not.toHaveBeenCalled();
  });
});
