// Вкладка «Графік оплат» на сторінці «Купівля» (переїхала зі сторінки оплат постачальникам).
//
//   - `?tab=schedule` показує графік; вкладка стоїть поруч із «Замовленнями» й «Поверненнями»;
//   - вкладку бачать лише ролі GET /supplier-payments/schedule (власник, адміністратор,
//     бухгалтер); комірник її не має, і пряма адреса відкриває йому «Замовлення»;
//   - бухгалтер, якому списки й картки замовлень закриті, бачить ЛИШЕ графік — сторінка
//     замовлень (із її запитами) для нього не монтується;
//   - клік по вкладці пише `tab=schedule` в адресу, інші параметри адреси лишаються.
//
// Mutation-verify:
//   - `requestedTab === 'schedule' && canSeeSchedule` → без `&& canSeeSchedule` → «комірник» падає;
//   - прибрати гілку `PurchaseSchedulePage` у `PurchaseOrdersRoute` → «бухгалтер» падає;
//   - прибрати `{activeTab === 'schedule' && …}` → «показує графік» падає.

import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';

let search = '';
const replaceMock = vi.fn((url: string) => {
  search = url.replace(/^\?/, '');
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
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

const usePurchaseOrdersMock = vi.fn(() => ({
  data: { items: [], total: 0, page: 1, limit: 20 },
  isLoading: false,
  error: null,
}));
vi.mock('@/hooks/api/usePurchaseOrders', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/usePurchaseOrders')>();
  return { ...actual, usePurchaseOrders: () => usePurchaseOrdersMock() };
});
vi.mock('@/hooks/api/useSupplierReturns', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/useSupplierReturns')>();
  return {
    ...actual,
    useSupplierReturns: () => ({
      data: { items: [], total: 0, page: 1, limit: 50 },
      isLoading: false,
    }),
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
// Сам графік має власний тест (SupplierPaymentScheduleTab.test.tsx) — тут важить, чи його показано.
vi.mock('../SupplierPaymentScheduleTab', () => ({
  SupplierPaymentScheduleTab: () => <div data-testid="schedule-tab" />,
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

const tabNames = () =>
  ['Замовлення постачальникам', 'Повернення постачальнику', 'Графік оплат'].filter(
    name => screen.queryByText(name) !== null,
  );

describe('«Купівля» — вкладка «Графік оплат»', () => {
  beforeEach(() => {
    search = '';
    role = 'OWNER';
    replaceMock.mockClear();
    requireAuthMock.mockClear();
    usePurchaseOrdersMock.mockClear();
  });

  it.each(['OWNER', 'ADMIN'])('%s: три вкладки, графік — третя', r => {
    role = r;
    renderPage();
    expect(tabNames()).toEqual([
      'Замовлення постачальникам',
      'Повернення постачальнику',
      'Графік оплат',
    ]);
    expect(screen.queryByTestId('schedule-tab')).not.toBeInTheDocument();
  });

  it('?tab=schedule показує графік замість списку замовлень', async () => {
    search = 'tab=schedule';
    renderPage();
    // Вкладка вантажиться окремим чанком (next/dynamic) — з'являється асинхронно.
    expect(await screen.findByTestId('schedule-tab')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Графік оплат' })).toHaveClass('text-primary');
    expect(screen.getByRole('button', { name: 'Замовлення постачальникам' })).not.toHaveClass(
      'text-primary',
    );
  });

  it('клік по вкладці пише tab=schedule в адресу й не губить інші параметри', () => {
    search = 'q=фільтр';
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Графік оплат' }));
    expect(replaceMock).toHaveBeenCalledTimes(1);
    const params = new URLSearchParams(replaceMock.mock.calls[0]![0].replace(/^\?/, ''));
    expect(params.get('tab')).toBe('schedule');
    expect(params.get('q')).toBe('фільтр');
  });

  it('комірник: вкладки немає, пряма адреса відкриває «Замовлення»', () => {
    role = 'STOREKEEPER';
    search = 'tab=schedule';
    renderPage();
    expect(tabNames()).toEqual(['Замовлення постачальникам', 'Повернення постачальнику']);
    expect(screen.queryByTestId('schedule-tab')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Замовлення постачальникам' })).toHaveClass(
      'text-primary',
    );
  });

  it('бухгалтер: лише графік, сторінка замовлень із її запитами не монтується', () => {
    role = 'ACCOUNTANT';
    renderPage();
    expect(screen.getByTestId('schedule-tab')).toBeInTheDocument();
    expect(tabNames()).toEqual(['Графік оплат']);
    expect(usePurchaseOrdersMock).not.toHaveBeenCalled();
    // Guard сторінки для бухгалтера — його власний, а не «власник / адміністратор / комірник».
    expect(requireAuthMock).toHaveBeenCalledWith(['ACCOUNTANT']);
    expect(requireAuthMock).not.toHaveBeenCalledWith(['OWNER', 'ADMIN', 'STOREKEEPER']);
  });
});
