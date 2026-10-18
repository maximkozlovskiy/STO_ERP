// BR-CP-014 (рішення власника 2026-10-18): комірник шукає постачальника в картці замовлення —
// `GET /counterparties` віддає йому лише постачальників і без телефону, тож другим рядком у
// пошуку — ЄДРПОУ. Картку контрагента (`GET /counterparties/:id`, редагування) комірник не
// читає: кнопка «Відкрити картку» біля постачальника для нього недоступна, для власника — є.

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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

const auth = vi.hoisted(() => ({ role: 'STOREKEEPER' }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { role: auth.role } }),
}));

vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));
vi.mock('@/components/ui/xlsx-import-button', () => ({ XlsxImportButton: () => null }));
vi.mock('@/components/ui/ExcelImportWizard', () => ({ ExcelImportWizard: () => null }));

const SUPPLIER = {
  id: 's-1',
  type: 'SUPPLIER',
  firstName: null,
  lastName: null,
  companyName: 'ТОВ Запчастини',
  edrpou: '30000001',
};

async function pickSupplier(role: string) {
  auth.role = role;
  apiFetchMock.mockImplementation((path: string) => {
    if (path.startsWith('/counterparties?q=')) return Promise.resolve({ items: [SUPPLIER] });
    if (path === '/warehouses') return Promise.resolve([{ id: 'w1', name: 'Склад №1' }]);
    if (path === '/settings/organisation') {
      return Promise.resolve({ vatMode: 'NONE', defaultVatRateId: null });
    }
    if (path === '/settings/tax-rates') return Promise.resolve([]);
    return Promise.resolve({ items: [] });
  });
  renderWithQueryClient(<PurchaseOrderCreateModal open onClose={vi.fn()} />);
  const input = await screen.findByPlaceholderText('Пошук постачальника…');
  const field = input.parentElement as HTMLElement;
  fireEvent.change(input, { target: { value: 'Запч' } });
  const option = await screen.findByRole('option', { name: /ТОВ Запчастини/ });
  expect(option).toHaveTextContent('30000001');
  // Вибір у списку — на mousedown (до blur поля), як у EntityPickerField.
  fireEvent.mouseDown(option);
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  expect(field).toHaveTextContent('ТОВ Запчастини');
  return field;
}

describe('PurchaseOrderCreateModal — постачальник для комірника (BR-CP-014)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  // guards: BR-CP-014
  it('комірник знаходить постачальника (ЄДРПОУ другим рядком), картка контрагента недоступна', async () => {
    const field = await pickSupplier('STOREKEEPER');
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/counterparties?q=%D0%97%D0%B0%D0%BF%D1%87&types=SUPPLIER&types=BOTH&limit=30',
    );
    expect(within(field).getByRole('button', { name: 'Відкрити картку' })).toBeDisabled();
  });

  it('власник відкриває картку постачальника, як раніше (контроль)', async () => {
    const field = await pickSupplier('OWNER');
    expect(within(field).getByRole('button', { name: 'Відкрити картку' })).toBeEnabled();
  });
});
