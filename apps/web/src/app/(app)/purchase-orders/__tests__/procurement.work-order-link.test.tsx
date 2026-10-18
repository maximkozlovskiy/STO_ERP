// Bug #900: комірник у «Нестачі» й «Позиціях» бачив номер наряду посиланням, а сторінки нарядів не
// має — клік вів на /403 через сім запитів із 403 (картка наряду встигала їх відправити). Номер
// наряду — посилання лише для ролей, яких пускає сторінка нарядів; комірнику — текст.
//
// Мутація: `canOpenWorkOrder` завжди true → падають кейси комірника.

import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { PurchaseListItem, ShortageRow } from '@/hooks/api/usePurchaseLists';

const toWorkOrder = vi.fn();
vi.mock('@/lib/linked-nav', () => ({
  useLinkedNav: () => ({ toWorkOrder, toPurchaseOrder: vi.fn() }),
}));
vi.mock('@/lib/api-client', () => ({
  apiFetch: (path: string) =>
    path.startsWith('/counterparties')
      ? Promise.resolve({ items: [], total: 0 })
      : Promise.resolve({ offerTtlMinutes: 60 }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
let role = 'STOREKEEPER';
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { id: 'e1', role } }) }));
vi.mock('@/hooks/api/useInfrastructure', () => ({ useWarehouses: () => ({ data: [] }) }));

const WO_ID = 'wo-1';
const WO_NUMBER = 'НРД-2026-000777';

const SHORTAGE = {
  workOrderPartId: 'wp-1',
  workOrderId: WO_ID,
  workOrderNumber: WO_NUMBER,
  workOrderStatus: 'APPROVED',
  plannedAt: null,
  goodId: 'g-1',
  goodName: 'Фільтр оливи',
  goodSku: 'OC 90',
  goodUnit: 'шт',
  warehouseId: 'w-1',
  warehouseName: 'Основний',
  required: 2,
  reserved: 0,
  inLists: 0,
  fromPool: 0,
  shortage: 2,
} as unknown as ShortageRow;

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
  quantity: 2,
  receivedQty: 0,
  reservedQty: 0,
  status: 'OPEN',
  source: 'WORK_ORDER',
  supplierId: null,
  supplierName: null,
  expectedPrice: null,
  workOrderId: WO_ID,
  workOrderNumber: WO_NUMBER,
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
    useShortage: () => ({
      data: { items: [SHORTAGE], total: 1 },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }),
    usePurchaseLists: () => ({ data: { items: [], total: 0 } }),
    usePurchaseListItems: () => ({
      data: { items: [ITEM], total: 1, page: 1, limit: 50 },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }),
  };
});
vi.mock('@/components/ui/purchase-list/AddToListDialog', () => ({ AddToListDialog: () => null }));
vi.mock('@/components/ui/purchase-list/SupplierOffersDialog', () => ({
  SupplierOffersDialog: () => null,
}));
vi.mock('@/components/ui/purchase-list/AutoAllocateDialog', () => ({
  AutoAllocateDialog: () => null,
}));

import { ShortageView } from '../procurement/ShortageView';
import { ItemsView } from '../procurement/ItemsView';

function renderWith(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const VIEWS = [
  ['Нестача', () => <ShortageView />],
  ['Позиції', () => <ItemsView canWrite />],
] as const;

beforeEach(() => {
  toWorkOrder.mockReset();
  role = 'STOREKEEPER';
});

describe('номер наряду в «Управлінні купівлями» — посилання лише для тих, кого пускає сторінка (Bug #900)', () => {
  it.each(VIEWS)('%s, комірник: номер наряду — текст, не кнопка', (_v, view) => {
    renderWith(view());
    expect(screen.getByText(WO_NUMBER)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: WO_NUMBER })).toBeNull();
  });

  it.each(VIEWS)('%s, приймальня: номер наряду відкриває наряд', (_v, view) => {
    role = 'RECEPTIONIST';
    renderWith(view());
    fireEvent.click(screen.getByRole('button', { name: WO_NUMBER }));
    expect(toWorkOrder).toHaveBeenCalledWith(WO_ID);
  });
});
