// Bug #889: «Управління купівлями» живе на сторінці «Купівля», і номер замовлення в позиції чи
// списку (`nav.toPurchaseOrder` → `?open=<id>`) міняв URL тієї ж сторінки без перемонтування.
// Deep-link читався лише при монтуванні — картка замовлення не відкривалась.
//
// Мутація: повернути залежності ефекту `[]` → кейс «той самий екземпляр сторінки» падає.

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
  PurchaseOrderCreateModal: (p: { open: boolean; purchaseOrderId?: string | null }) =>
    p.open && p.purchaseOrderId ? <div data-testid="po-card">{p.purchaseOrderId}</div> : null,
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

const PO_ID = '11111111-1111-4111-8111-111111111111';

function page() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <PurchaseOrdersPage />
    </QueryClientProvider>
  );
}

describe('«Купівля» — ?open= на вже відкритій сторінці (Bug #889)', () => {
  beforeEach(() => {
    role = 'OWNER';
    search = 'tab=procurement&view=items';
  });

  // Картка — next/dynamic (бюджет first-load сторінки): з'являється після завантаження чанка.
  it('при монтуванні ?open= відкриває картку замовлення', async () => {
    search = `open=${PO_ID}`;
    render(page());
    expect(await screen.findByTestId('po-card')).toHaveTextContent(PO_ID);
  });

  it('той самий екземпляр сторінки: перехід із «Управління купівлями» на ?open= відкриває картку', async () => {
    const view = render(page());
    expect(screen.queryByTestId('po-card')).not.toBeInTheDocument();

    search = `open=${PO_ID}`;
    view.rerender(page());

    expect(await screen.findByTestId('po-card')).toHaveTextContent(PO_ID);
  });
});
