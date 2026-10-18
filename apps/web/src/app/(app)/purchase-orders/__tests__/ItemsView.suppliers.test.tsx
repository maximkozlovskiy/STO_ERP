// «Позиції» → «Постачальник і ціна» для комірника (BR-CP-014, рішення власника 2026-10-18):
// комірник читає постачальників (`GET /counterparties` — сервер віддає йому лише постачальників),
// тож фільтр і масова зміна постачальника мають список, а позиція отримує обраного. Підказка під
// полем — лише після відповіді: «немає постачальників» чи «не завантажився», не «недоступно ролі».

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { PurchaseListItem } from '@/hooks/api/usePurchaseLists';

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/linked-nav', () => ({
  useLinkedNav: () => ({ toWorkOrder: vi.fn(), toPurchaseOrder: vi.fn() }),
}));
let role = 'STOREKEEPER';
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { id: 'e1', role } }) }));
vi.mock('@/hooks/api/useInfrastructure', () => ({ useWarehouses: () => ({ data: [] }) }));

const ITEM = {
  id: 'it-1',
  listId: 'l-1',
  listNumber: 'СК-1',
  goodId: 'g-1',
  goodName: 'Фільтр оливи',
  goodSku: 'OC 90',
  goodUnit: 'шт',
  warehouseId: 'w-1',
  warehouseName: 'Основний',
  quantity: 4,
  receivedQty: 0,
  reservedQty: 0,
  status: 'OPEN',
  source: 'MANUAL',
  supplierId: null,
  supplierName: null,
  expectedPrice: null,
  workOrderId: null,
  workOrderNumber: null,
  purchaseOrderId: null,
  purchaseOrderNumber: null,
  purchaseOrderStatus: null,
  offerConnectionId: null,
  originalGoodId: null,
} as unknown as PurchaseListItem;

vi.mock('@/hooks/api/usePurchaseLists', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/usePurchaseLists')>();
  return {
    ...actual,
    usePurchaseLists: () => ({ data: { items: [], total: 0 } }),
    usePurchaseListItems: () => ({
      data: { items: [ITEM], total: 1, page: 1, limit: 50 },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }),
  };
});
vi.mock('@/components/ui/purchase-list/SupplierOffersDialog', () => ({
  SupplierOffersDialog: () => null,
}));
vi.mock('@/components/ui/purchase-list/AutoAllocateDialog', () => ({
  AutoAllocateDialog: () => null,
}));

import { ItemsView } from '../procurement/ItemsView';

const SUPPLIERS_URL = '/counterparties?types=SUPPLIER&types=BOTH&limit=200';
let suppliers: () => Promise<unknown>;

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ItemsView canWrite />
    </QueryClientProvider>,
  );
}

async function openSupplierDialog() {
  fireEvent.click(await screen.findByLabelText('Вибрати Фільтр оливи'));
  fireEvent.click(screen.getByRole('button', { name: /Постачальник і ціна/ }));
  return screen.findByRole('dialog');
}

beforeEach(() => {
  apiFetch.mockReset();
  role = 'STOREKEEPER';
  suppliers = () =>
    Promise.resolve({
      items: [{ id: 's-1', type: 'SUPPLIER', companyName: 'ТОВ Запчастини', edrpou: '30000001' }],
      total: 1,
    });
  apiFetch.mockImplementation((path: string) => {
    if (path === SUPPLIERS_URL) return suppliers();
    if (path === '/supplier-offers/settings') return Promise.resolve({ offerTtlMinutes: 60 });
    if (path === '/purchase-list-items/bulk-update') return Promise.resolve({ count: 1 });
    return Promise.reject(new Error(`unexpected ${String(path)}`));
  });
});

describe('ItemsView — постачальники для комірника (BR-CP-014)', () => {
  // guards: BR-CP-014
  it('комірник читає постачальників: фільтр має їх, масова зміна ставить обраного', async () => {
    renderView();
    const filter = screen.getByRole('combobox', { name: 'Постачальник' });
    await waitFor(() =>
      expect(within(filter).getByRole('option', { name: 'ТОВ Запчастини' })).toBeInTheDocument(),
    );
    expect(apiFetch).toHaveBeenCalledWith(SUPPLIERS_URL, expect.anything());

    const dialog = await openSupplierDialog();
    const select = within(dialog).getByRole('combobox', { name: 'Постачальник' });
    fireEvent.change(select, { target: { value: 's-1' } });
    expect(within(dialog).queryByText(/недоступний для вашої ролі/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Зберегти' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/purchase-list-items/bulk-update',
        expect.objectContaining({
          body: JSON.stringify({ itemIds: ['it-1'], supplierId: 's-1' }),
        }),
      ),
    );
  });

  // guards: BR-CP-014
  it('постачальників немає, комірник — «попросіть власника», бо створити контрагента не може', async () => {
    suppliers = () => Promise.resolve({ items: [], total: 0 });
    renderView();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(SUPPLIERS_URL, expect.anything()));
    const dialog = await openSupplierDialog();
    expect(await within(dialog).findByText(/Постачальників немає/)).toHaveTextContent(
      /попросіть власника чи адміністратора/,
    );
    expect(within(dialog).queryByText(/додайте контрагента/)).toBeNull();
  });

  it.each(['OWNER', 'ADMIN'])(
    'постачальників немає, %s — «додайте контрагента», а не «недоступно ролі»',
    async r => {
      role = r;
      suppliers = () => Promise.resolve({ items: [], total: 0 });
      renderView();
      const dialog = await openSupplierDialog();
      expect(await within(dialog).findByText(/Постачальників немає/)).toHaveTextContent(
        /додайте контрагента з типом «Постачальник»/,
      );
    },
  );

  it('список не завантажився — підказка про збій', async () => {
    suppliers = () => Promise.reject(new Error('збій мережі'));
    renderView();
    const dialog = await openSupplierDialog();
    expect(await within(dialog).findByText(/не завантажився/)).toBeInTheDocument();
  });
});
