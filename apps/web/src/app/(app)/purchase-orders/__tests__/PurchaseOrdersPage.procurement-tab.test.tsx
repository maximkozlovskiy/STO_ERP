// Вкладка «Управління купівлями» на сторінці «Купівля» (docs/objects/purchase-list.md, BR-PL-015).
//
//   - власник, адміністратор, комірник бачать вкладку поруч із замовленнями й поверненнями;
//   - `?tab=procurement` показує вкладку;
//   - приймальня бачить ЛИШЕ цю вкладку — сторінка замовлень (із її запитами) не монтується;
//   - бухгалтер вкладки не має (лише графік оплат).
//
// Mutation-verify:
//   - прибрати гілку `PurchaseProcurementPage` у `PurchaseOrdersRoute` → «приймальня» падає;
//   - прибрати `{activeTab === 'procurement' && …}` → «?tab=procurement» падає.

import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';

let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => '/purchase-orders',
}));

let role = 'OWNER';
const requireAuthMock = vi.fn((_roles?: string[]) => ({ employee: { id: 'e1', role } }));
vi.mock('@/lib/auth', () => ({
  useRequireAuth: (roles?: string[]) => requireAuthMock(roles),
  useAuth: () => ({ employee: { id: 'e1', role } }),
}));

vi.mock('@/lib/api-client', () => ({
  apiFetch: () => Promise.resolve({ items: [], total: 0 }),
}));

const usePurchaseOrdersMock = vi.fn((..._args: unknown[]) => ({
  data: { items: [], total: 0, page: 1, limit: 20 },
  isLoading: false,
  error: null,
}));
vi.mock('@/hooks/api/usePurchaseOrders', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/usePurchaseOrders')>();
  return {
    ...actual,
    usePurchaseOrders: (...args: unknown[]) => usePurchaseOrdersMock(...args),
  };
});
const useSupplierReturnsMock = vi.fn((..._args: unknown[]) => ({
  data: { items: [], total: 0, page: 1, limit: 50 },
  isLoading: false,
}));
vi.mock('@/hooks/api/useSupplierReturns', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/useSupplierReturns')>();
  return {
    ...actual,
    useSupplierReturns: (...args: unknown[]) => useSupplierReturnsMock(...args),
  };
});
vi.mock('@/hooks/api/useCash', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/useCash')>();
  return { ...actual, useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }) };
});
vi.mock('@/components/ui/SupplierReturnCreateModal', () => ({
  SupplierReturnCreateModal: () => null,
}));
vi.mock('@/components/ui/PurchaseOrderCreateModal', () => ({
  PurchaseOrderCreateModal: () => null,
}));
vi.mock('@/components/ui/date-picker-input', () => ({ DatePickerInput: () => null }));
vi.mock('../SupplierPaymentScheduleTab', () => ({
  SupplierPaymentScheduleTab: () => <div data-testid="schedule-tab" />,
}));
// Сама вкладка має власний тест (ProcurementTab.test.tsx) — тут важить, чи її показано.
vi.mock('../ProcurementTab', () => ({
  ProcurementTab: () => <div data-testid="procurement-tab" />,
}));

import PurchaseOrdersPage from '../page';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PurchaseOrdersPage />
    </QueryClientProvider>,
  );
}

const PROCUREMENT = 'Управління купівлями';

describe('«Купівля» — вкладка «Управління купівлями»', () => {
  beforeEach(() => {
    search = '';
    role = 'OWNER';
    requireAuthMock.mockClear();
    usePurchaseOrdersMock.mockClear();
    useSupplierReturnsMock.mockClear();
  });

  // sto-optimize: списки інших вкладок читаються лише на своїй вкладці — «Управління купівлями»
  // не тягне замовлень, їхніх лічильників зв'язків і повернень (і не перечитує їх після дій).
  it('?tab=procurement: замовлення й повернення не читаються; на «Замовленнях» — лише замовлення', () => {
    search = 'tab=procurement';
    const { unmount } = renderPage();
    expect(usePurchaseOrdersMock.mock.calls.at(-1)?.[1]).toBe(false);
    expect(useSupplierReturnsMock.mock.calls.at(-1)?.[1]).toBe(false);
    unmount();

    search = '';
    renderPage();
    expect(usePurchaseOrdersMock.mock.calls.at(-1)?.[1]).toBe(true);
    expect(useSupplierReturnsMock.mock.calls.at(-1)?.[1]).toBe(false);
  });

  // guards: BR-PL-015
  it.each(['OWNER', 'ADMIN', 'STOREKEEPER'])('%s: вкладка є поруч із документами', r => {
    role = r;
    renderPage();
    expect(screen.getByRole('button', { name: PROCUREMENT })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Замовлення постачальникам' })).toBeInTheDocument();
    expect(screen.queryByTestId('procurement-tab')).not.toBeInTheDocument();
  });

  // guards: BR-PL-015
  it('?tab=procurement показує вкладку', () => {
    search = 'tab=procurement';
    renderPage();
    expect(screen.getByTestId('procurement-tab')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: PROCUREMENT })).toHaveClass('text-primary');
  });

  // guards: BR-PL-015
  it('приймальня: лише «Управління купівлями», сторінка замовлень не монтується', () => {
    role = 'RECEPTIONIST';
    search = 'tab=orders';
    renderPage();
    expect(screen.getByTestId('procurement-tab')).toBeInTheDocument();
    expect(screen.queryByText('Замовлення постачальникам')).not.toBeInTheDocument();
    expect(screen.queryByText('Графік оплат')).not.toBeInTheDocument();
    expect(usePurchaseOrdersMock).not.toHaveBeenCalled();
    expect(requireAuthMock).toHaveBeenCalledWith(['RECEPTIONIST']);
  });

  // Механік не має жодної вкладки «Купівлі»: лише перенаправлення на /403, без монтування сторінки
  // замовлень і її запитів (раніше вони йшли й отримували 403 — owner 2026-10-18).
  it('механік: сторінка замовлень не монтується, лише перенаправлення на /403', () => {
    role = 'MECHANIC';
    const { container } = renderPage();
    expect(usePurchaseOrdersMock).not.toHaveBeenCalled();
    expect(useSupplierReturnsMock).not.toHaveBeenCalled();
    expect(requireAuthMock).toHaveBeenCalledWith(['OWNER', 'ADMIN', 'STOREKEEPER']);
    expect(container).toBeEmptyDOMElement();
  });

  // guards: BR-PL-015
  it('бухгалтер: вкладки немає (лише графік оплат)', async () => {
    role = 'ACCOUNTANT';
    renderPage();
    expect(screen.queryByText(PROCUREMENT)).not.toBeInTheDocument();
    expect(await screen.findByTestId('schedule-tab')).toBeInTheDocument();
  });
});
