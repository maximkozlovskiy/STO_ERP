// Bug #934: спільні схеми `@sto/shared` кладуть у `issue.message` ключ перекладу. Ручний
// `safeParse` у картці замовлення показував його в банері як є —
// «v.purchaseOrder.warehouse.required» замість «Оберіть склад».

import { fireEvent, screen, waitFor } from '@testing-library/react';
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

const SUPPLIER = {
  // UUID: схема перевіряє формат, і з 's-1' першою була б помилка постачальника, а не складу.
  id: '11111111-1111-4111-8111-111111111111',
  type: 'SUPPLIER',
  firstName: null,
  lastName: null,
  companyName: 'ТОВ Запчастини',
  edrpou: '30000001',
};

describe('PurchaseOrderCreateModal — текст помилки перевірки (Bug #934)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path.startsWith('/counterparties?q=')) return Promise.resolve({ items: [SUPPLIER] });
      // Два склади — без авто-вибору єдиного (Bug #639), склад лишається порожнім.
      if (path === '/warehouses') {
        return Promise.resolve([
          { id: 'w1', name: 'Склад №1' },
          { id: 'w2', name: 'Склад №2' },
        ]);
      }
      if (path === '/settings/organisation') {
        return Promise.resolve({ vatMode: 'NONE', defaultVatRateId: null });
      }
      if (path === '/settings/tax-rates') return Promise.resolve([]);
      return Promise.resolve({ items: [] });
    });
  });

  it('без складу «Завантажити з Excel» пише «Оберіть склад», а не ключ перекладу', async () => {
    renderWithQueryClient(<PurchaseOrderCreateModal open onClose={vi.fn()} />);
    const input = await screen.findByPlaceholderText('Пошук постачальника…');
    fireEvent.change(input, { target: { value: 'Запч' } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: /ТОВ Запчастини/ }));
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Завантажити з Excel' }));

    expect(await screen.findByText('Оберіть склад')).toBeInTheDocument();
    expect(screen.queryByText(/v\.purchaseOrder\./)).not.toBeInTheDocument();
    expect(apiFetchMock).not.toHaveBeenCalledWith('/purchase-orders', expect.anything());
  });
});
