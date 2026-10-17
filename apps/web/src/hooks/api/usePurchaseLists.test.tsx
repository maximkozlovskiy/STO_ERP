// usePurchaseLists — контракт із бекендом списків купівлі: шляхи й параметри (supplierId=none —
// позиції без постачальника), стан наряду не запитується без id, а всі ключі лежать у просторі
// `purchaseListsKeys.all` — тому `invalidateProcurementSideEffects` оновлює й картку наряду.
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }) }));

import {
  purchaseListsKeys,
  purchaseListsApi,
  usePurchaseListItems,
  useShortage,
  useWorkOrderProcurement,
} from './usePurchaseLists';

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({ items: [], total: 0, page: 1, limit: 50, shortage: [] });
});

it('позиції: фільтри в query, «без постачальника» — supplierId=none', async () => {
  renderHook(
    () => usePurchaseListItems({ status: 'OPEN', supplierId: 'none', q: 'фільтр', page: 2 }),
    { wrapper: wrapper() },
  );
  await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
  const url = String(apiFetchMock.mock.calls[0]![0]);
  expect(url.startsWith('/purchase-list-items?')).toBe(true);
  const params = new URLSearchParams(url.split('?')[1]);
  expect(Object.fromEntries(params)).toEqual({
    status: 'OPEN',
    supplierId: 'none',
    q: 'фільтр',
    page: '2',
  });
});

it('нестача — GET /purchase-list-items/shortage з фільтром складу', async () => {
  renderHook(() => useShortage({ warehouseId: 'w1', limit: 200 }), { wrapper: wrapper() });
  await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
  expect(apiFetchMock.mock.calls[0]![0]).toBe(
    '/purchase-list-items/shortage?warehouseId=w1&limit=200',
  );
});

it('стан наряду: без id запиту немає; з id — by-work-order', async () => {
  const { rerender } = renderHook(({ id }) => useWorkOrderProcurement(id), {
    wrapper: wrapper(),
    initialProps: { id: null as string | null },
  });
  expect(apiFetchMock).not.toHaveBeenCalled();
  rerender({ id: 'wo-1' });
  await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
  expect(apiFetchMock.mock.calls[0]![0]).toBe('/purchase-list-items/by-work-order/wo-1');
});

it('ключі — у просторі purchase-lists (спільна інвалідація)', () => {
  for (const key of [
    purchaseListsKeys.list({}),
    purchaseListsKeys.items({}),
    purchaseListsKeys.shortage({}),
    purchaseListsKeys.byWorkOrder('x'),
    purchaseListsKeys.detail('x'),
  ]) {
    expect(key[0]).toBe(purchaseListsKeys.all[0]);
  }
});

it('мутації — POST на правильні шляхи; DELETE без тіла', async () => {
  apiFetchMock.mockResolvedValue({});
  await purchaseListsApi.createOrders(['i1']);
  await purchaseListsApi.releaseReservation('i1');
  await purchaseListsApi.remove('l1');
  expect(apiFetchMock.mock.calls.map(c => [c[0], (c[1] as { method: string }).method])).toEqual([
    ['/purchase-lists/create-orders', 'POST'],
    ['/purchase-list-items/i1/release-reservation', 'POST'],
    ['/purchase-lists/l1', 'DELETE'],
  ]);
  expect((apiFetchMock.mock.calls[1]![1] as { body?: string }).body).toBeUndefined();
});
