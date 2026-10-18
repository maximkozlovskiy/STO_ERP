// «Позиції» → пропозиції постачальників (docs/objects/supplier-offer.md): бейдж обраної пропозиції
// (склад, термін, давність, «застаріла» за TTL), дія «Пропозиції» й масова «Підібрати автоматично»
// — лише ролям закупівлі; приймальня не бачить ні дій, ні цін пропозицій і не питає налаштувань
// закупівлі (BR-SOFR-010, Bug #729 — фонове 403).

import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { PurchaseListItem } from '@/hooks/api/usePurchaseLists';

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/linked-nav', () => ({
  useLinkedNav: () => ({ toWorkOrder: vi.fn(), toPurchaseOrder: vi.fn() }),
}));
let role = 'OWNER';
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { id: 'e1', role } }) }));
vi.mock('@/hooks/api/useInfrastructure', () => ({ useWarehouses: () => ({ data: [] }) }));

let items: PurchaseListItem[] = [];
vi.mock('@/hooks/api/usePurchaseLists', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/usePurchaseLists')>();
  return {
    ...actual,
    usePurchaseLists: () => ({ data: { items: [], total: 0 } }),
    usePurchaseListItems: () => ({
      data: { items, total: items.length, page: 1, limit: 50 },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }),
  };
});
vi.mock('@/components/ui/purchase-list/SupplierOffersDialog', () => ({
  SupplierOffersDialog: ({ item }: { item: { id: string } | null }) =>
    item ? <div data-testid="offers-dialog-stub">{item.id}</div> : null,
}));
vi.mock('@/components/ui/purchase-list/AutoAllocateDialog', () => ({
  AutoAllocateDialog: ({ ids }: { ids: string[] | null }) =>
    ids ? <div data-testid="allocate-stub">{ids.join(',')}</div> : null,
}));

import { ItemsView } from '../procurement/ItemsView';

const HOUR = 60 * 60_000;

const item = (over: Partial<PurchaseListItem> = {}): PurchaseListItem =>
  ({
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
    supplierId: 's-1',
    supplierName: 'UTR ТОВ',
    expectedPrice: 134.28,
    workOrderId: null,
    workOrderNumber: null,
    purchaseOrderId: null,
    purchaseOrderNumber: null,
    purchaseOrderStatus: null,
    offerConnectionId: 'c-1',
    offerKey: 'k-1',
    offerSupplierItemId: 'si',
    offerArticle: 'OC 90',
    offerBrand: 'MAHLE',
    offerWarehouseCode: 'w',
    offerWarehouseName: 'Київ Правий',
    offerDeliveryDays: 2,
    offerDeliveryDate: null,
    offerPrice: 2,
    offerCurrencyCode: 'EUR',
    offerMultiplicity: null,
    offerIsAnalog: false,
    offeredAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    offerChosenBy: 'MANUAL',
    originalGoodId: null,
    ...over,
  }) as PurchaseListItem;

function renderView(canWrite: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ItemsView canWrite={canWrite} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetch.mockReset();
  role = 'OWNER';
  items = [item()];
  apiFetch.mockImplementation((path: string) => {
    if (path === '/supplier-offers/settings')
      return Promise.resolve({
        defaultStrategy: 'OPTIMAL',
        offerTtlMinutes: 60,
        allowSplit: true,
        allowAnalogsInAuto: false,
        analogPolicy: 'CATALOG_ONLY',
      });
    if (path.startsWith('/counterparties')) return Promise.resolve({ items: [] });
    return Promise.reject(new Error(`unexpected ${String(path)}`));
  });
});

describe('ItemsView — пропозиції', () => {
  // guards: BR-SOFR-003
  it('бейдж обраної пропозиції: склад, термін, давність; старша за TTL — «застаріла»', async () => {
    renderView(true);
    const badge = await screen.findByTestId('offer-badge');
    expect(badge).toHaveTextContent('Київ Правий · 2 дн. · 2 год тому');
    expect(await within(badge).findByText(/застаріла/)).toBeInTheDocument();
    // Ціни пропозиції в бейджі немає ні для кого — ціна позиції лише в колонці «Ціна».
    expect(badge).not.toHaveTextContent(/EUR|2,00/);
  });

  it('«Пропозиції» в рядку й «Підібрати автоматично» масово відкривають свої діалоги', async () => {
    renderView(true);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Пропозиції постачальників для Фільтр оливи' }),
    );
    expect(screen.getByTestId('offers-dialog-stub')).toHaveTextContent('it-1');
    fireEvent.click(screen.getByLabelText('Вибрати Фільтр оливи'));
    fireEvent.click(screen.getByRole('button', { name: /Підібрати автоматично/ }));
    expect(screen.getByTestId('allocate-stub')).toHaveTextContent('it-1');
  });

  // guards: BR-SOFR-010
  it('приймальня: без дій пропозицій, без цін і без запиту налаштувань закупівлі', async () => {
    role = 'RECEPTIONIST';
    items = [item({ expectedPrice: null, offerPrice: null })];
    renderView(false);
    const row = await screen.findByTestId('purchase-list-item-row');
    expect(within(row).getByTestId('offer-badge')).not.toHaveTextContent(/застаріла|EUR|₴/);
    expect(screen.queryByRole('button', { name: /Пропозиції постачальників/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Підібрати автоматично/ })).toBeNull();
    expect(within(row).queryByText(/134|2,00/)).toBeNull();
    expect(apiFetch).not.toHaveBeenCalledWith('/supplier-offers/settings', expect.anything());
  });
});
