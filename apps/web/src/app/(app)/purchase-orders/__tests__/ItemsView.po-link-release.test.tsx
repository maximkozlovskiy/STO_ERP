// Bug #914: приймальня в «Позиціях» бачила номер замовлення кнопкою, а картки замовлення не має
// (`GET /purchase-orders/:id` — 403, сторінка «Купівля» для неї — лише вкладка «Управління
// купівлями»): клік міняв URL на `?open=…` і нічого не відкривав. Номер — текст.
// Bug #913: «Зняти резерв» показувалось на позиції завершеного наряду — резерв уже списано
// (BR-WO-021), і кнопка давала 400 `nothingToRelease`. Кнопка — лише поки наряд активний.
//
// Мутації: `canOpenPurchaseOrder` завжди true → падає кейс приймальні; `reservationReleasable`
// завжди true → падає кейс «Виконано».

import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { PurchaseListItem } from '@/hooks/api/usePurchaseLists';

const toPurchaseOrder = vi.fn();
vi.mock('@/lib/linked-nav', () => ({
  useLinkedNav: () => ({ toWorkOrder: vi.fn(), toPurchaseOrder }),
}));
vi.mock('@/lib/api-client', () => ({
  apiFetch: (path: string) =>
    path.startsWith('/counterparties')
      ? Promise.resolve({ items: [], total: 0 })
      : Promise.resolve({ offerTtlMinutes: 60 }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
let role = 'RECEPTIONIST';
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { id: 'e1', role } }) }));
vi.mock('@/hooks/api/useInfrastructure', () => ({ useWarehouses: () => ({ data: [] }) }));

const PO_ID = 'po-1';
const PO_NUMBER = 'ЗАМ-2026-000555';

const base = {
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
  receivedQty: 2,
  reservedQty: 2,
  status: 'RECEIVED',
  source: 'WORK_ORDER',
  supplierId: null,
  supplierName: null,
  expectedPrice: null,
  workOrderId: 'wo-1',
  workOrderNumber: 'НРД-2026-000777',
  workOrderStatus: 'IN_PROGRESS',
  purchaseOrderId: PO_ID,
  purchaseOrderNumber: PO_NUMBER,
  purchaseOrderStatus: 'RECEIVED',
  offerConnectionId: null,
  originalGoodId: null,
};
let item: PurchaseListItem = base as unknown as PurchaseListItem;

vi.mock('@/hooks/api/usePurchaseLists', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/usePurchaseLists')>();
  return {
    ...actual,
    usePurchaseLists: () => ({ data: { items: [], total: 0 } }),
    usePurchaseListItems: () => ({
      data: { items: [item], total: 1, page: 1, limit: 50 },
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

function renderView(canWrite: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ItemsView canWrite={canWrite} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  toPurchaseOrder.mockReset();
  role = 'RECEPTIONIST';
  item = base as unknown as PurchaseListItem;
});

describe('номер замовлення в «Позиціях» — посилання лише для ролей із карткою замовлення (Bug #914)', () => {
  it('приймальня: номер замовлення — текст, не кнопка', () => {
    renderView(false);
    expect(screen.getByText(PO_NUMBER)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: PO_NUMBER })).toBeNull();
  });

  it.each(['STOREKEEPER', 'ADMIN'])('%s: номер замовлення відкриває картку', r => {
    role = r;
    renderView(true);
    fireEvent.click(screen.getByRole('button', { name: PO_NUMBER }));
    expect(toPurchaseOrder).toHaveBeenCalledWith(PO_ID);
  });
});

describe('«Зняти резерв» — лише поки наряд позиції тримає резерв (Bug #913, BR-PL-016)', () => {
  it.each(['IN_PROGRESS', 'APPROVED', 'ON_HOLD'])('наряд %s: кнопка є', status => {
    role = 'STOREKEEPER';
    item = { ...base, workOrderStatus: status } as unknown as PurchaseListItem;
    renderView(true);
    expect(screen.getByRole('button', { name: 'Зняти резерв' })).toBeInTheDocument();
  });

  it.each(['COMPLETED', 'INVOICED', 'CANCELLED'])(
    'наряд %s: резерв списано чи знято — кнопки немає',
    status => {
      role = 'STOREKEEPER';
      item = { ...base, workOrderStatus: status } as unknown as PurchaseListItem;
      renderView(true);
      expect(screen.queryByRole('button', { name: 'Зняти резерв' })).toBeNull();
    },
  );
});
