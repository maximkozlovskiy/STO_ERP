// Bug #1017 (клас Bug #1014 рахунку): «Додати» згортає шапку картки замовлення (0fr +
// overflow-hidden), а смуга помилки жила в шапці — відмова «Зберегти зміни» була невидима, картка
// мовчки лишалась відкритою. Помилка — над шапкою (`DocumentCardBody`), `role="alert"`.
//
// Мутація (перевірено): повернути `{error && …}` усередину `CollapsibleDocumentHeader` → тест падає.

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { role: 'OWNER' } }) }));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));
vi.mock('@/components/ui/xlsx-import-button', () => ({ XlsxImportButton: () => null }));
vi.mock('@/components/ui/ExcelImportWizard', () => ({ ExcelImportWizard: () => null }));

const PO = {
  id: 'po-1',
  number: 'ЗАМ-000001',
  status: 'DRAFT',
  supplierId: '11111111-1111-4111-8111-111111111111',
  supplierName: 'Постачальник',
  warehouseId: '22222222-2222-4222-8222-222222222222',
  documentDate: '2026-10-13',
  totalAmount: 400,
  deletedAt: null,
  lines: [
    {
      id: 'l1',
      goodId: '33333333-3333-4333-8333-333333333333',
      goodName: 'Фільтр',
      quantity: 8,
      price: 50,
      receivedQty: 0,
    },
  ],
};

describe('Картка замовлення — помилка видима при згорнутій шапці (Bug #1017)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string, init?: { method?: string }) => {
      if (path === '/purchase-orders/po-1' && init?.method === 'PATCH') {
        return Promise.reject(new Error('Збій мережі'));
      }
      if (path.startsWith('/purchase-orders/po-1')) return Promise.resolve(PO);
      if (path === '/warehouses') {
        return Promise.resolve([
          { id: '22222222-2222-4222-8222-222222222222', name: 'Склад №1', deletedAt: null },
        ]);
      }
      if (path === '/settings/organisation') {
        return Promise.resolve({ vatMode: 'NONE', defaultVatRateId: null });
      }
      if (path === '/settings/tax-rates') return Promise.resolve([]);
      return Promise.resolve({ items: [] });
    });
  });

  it('«Додати» згорнуло шапку, відмова збереження — над шапкою з role="alert"', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithQueryClient(
      <PurchaseOrderCreateModal open purchaseOrderId="po-1" onClose={onClose} onSaved={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getAllByText('Фільтр').length).toBeGreaterThan(0));

    await user.click(screen.getByRole('button', { name: 'Додати' }));
    const header = screen.getByTestId('document-card-header');
    expect(header).toHaveAttribute('data-collapsed', 'true');

    await user.click(screen.getByRole('button', { name: 'Зберегти зміни' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Збій мережі');
    expect(alert).toHaveAttribute('data-testid', 'po-card-error');
    expect(header.contains(alert)).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });
});
