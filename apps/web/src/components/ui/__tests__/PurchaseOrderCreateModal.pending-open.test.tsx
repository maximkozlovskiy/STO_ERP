// Bug #935: «Відкрити картку» постачальника спершу вантажить контрагента. Поки запит у дорозі,
// картки ще немає в стеку Escape — Escape закривав замовлення (з постачальником — запит «Є незбережені
// зміни»), а картка, що приходила слідом, відкривалась сама. Тепер Escape скасовує відкриття.

import { fireEvent, screen, waitFor, within, act } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { PurchaseOrderCreateModal } from '../PurchaseOrderCreateModal';
import { renderWithQueryClient } from '../../../__tests__/query-utils';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role: 'OWNER' } }),
}));

vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));
vi.mock('@/components/ui/xlsx-import-button', () => ({ XlsxImportButton: () => null }));
vi.mock('@/components/ui/ExcelImportWizard', () => ({ ExcelImportWizard: () => null }));
vi.mock('@/components/ui/CounterpartyEditModal', () => ({
  CounterpartyEditModal: ({ open }: { open: boolean }) =>
    open ? <div role="dialog" aria-label="Редагування контрагента" /> : null,
}));

const SUPPLIER = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'SUPPLIER',
  firstName: null,
  lastName: null,
  companyName: 'ТОВ Запчастини',
  edrpou: '30000001',
};

let resolveSupplier: (v: unknown) => void;

describe('PurchaseOrderCreateModal — картка постачальника, що вантажиться (Bug #935)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path.startsWith('/counterparties?q=')) return Promise.resolve({ items: [SUPPLIER] });
      if (path === `/counterparties/${SUPPLIER.id}`) {
        return new Promise(resolve => {
          resolveSupplier = resolve;
        });
      }
      if (path === '/warehouses') return Promise.resolve([{ id: 'w1', name: 'Склад №1' }]);
      if (path === '/settings/organisation') {
        return Promise.resolve({ vatMode: 'NONE', defaultVatRateId: null });
      }
      if (path === '/settings/tax-rates') return Promise.resolve([]);
      return Promise.resolve({ items: [] });
    });
  });

  it('Escape під час запиту скасовує відкриття картки, замовлення лишається без запиту', async () => {
    const onClose = vi.fn();
    renderWithQueryClient(<PurchaseOrderCreateModal open onClose={onClose} />);
    const input = await screen.findByPlaceholderText('Пошук постачальника…');
    const field = input.parentElement as HTMLElement;
    fireEvent.change(input, { target: { value: 'Запч' } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: /ТОВ Запчастини/ }));
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());

    fireEvent.click(within(field).getByRole('button', { name: 'Відкрити картку' }));
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(`/counterparties/${SUPPLIER.id}`),
    );

    fireEvent.keyDown(document.body, { key: 'Escape' });
    await act(async () => {
      resolveSupplier({ ...SUPPLIER });
      await Promise.resolve();
    });

    expect(screen.queryByText('Є незбережені зміни')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('dialog', { name: 'Редагування контрагента' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Нове замовлення постачальнику')).toBeInTheDocument();
  });
});
