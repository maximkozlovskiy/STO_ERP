// useWarranties — гарантії наряду/контрагента + expiring-віджет дашборда.
// Bug #718 regression: create/claim мутації МУСЯТЬ інвалідувати НЕ лише `warrantiesKeys.all`,
// а й `dashboardKeys.expiringWarranties()` — окремий ключ дашборд-віджета. Без цього
// нова/claimed гарантія висіла у віджеті «Гарантії, що закінчуються» до staleTime.
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { warrantiesKeys, useCreateWarranty, useClaimWarranty } from './useWarranties';
import { dashboardKeys } from './useDashboardData';

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe('useWarranties mutations — cache invalidation (Bug #718)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('warrantiesKeys factory: різні id → різні ключі, спільний префікс', () => {
    expect(warrantiesKeys.all).toEqual(['warranties']);
    expect(warrantiesKeys.byWorkOrder('a')).not.toEqual(warrantiesKeys.byWorkOrder('b'));
    expect(warrantiesKeys.byCounterparty('a')).not.toEqual(warrantiesKeys.byWorkOrder('a'));
    expect(warrantiesKeys.expiring(30)).not.toEqual(warrantiesKeys.expiring(60));
  });

  it('useCreateWarranty → POST /warranties + інвалідує warranties.all ТА dashboard.expiringWarranties', async () => {
    const { client, wrapper } = createWrapper();
    const spy = vi.spyOn(client, 'invalidateQueries');
    apiFetchMock.mockResolvedValueOnce({ id: 'w1', isActive: true });

    const { result } = renderHook(() => useCreateWarranty(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        workOrderId: 'wo1',
        counterpartyId: 'cp1',
        expiresAt: '2027-01-01T23:59:59Z',
      });
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/warranties',
      expect.objectContaining({ method: 'POST' }),
    );
    const calls = spy.mock.calls.map(c => JSON.stringify(c[0]?.queryKey ?? c[0]));
    expect(calls).toContain(JSON.stringify(warrantiesKeys.all));
    // MUTATION-VERIFY: якщо повернути onSuccess лише на warrantiesKeys.all (стан до фіксу
    // Bug #718) — цей assert впаде, бо дашборд-віджет не інвалідовано.
    expect(calls).toContain(JSON.stringify(dashboardKeys.expiringWarranties()));
  });

  it('useClaimWarranty → POST /:id/claim + інвалідує warranties.all ТА dashboard.expiringWarranties', async () => {
    const { client, wrapper } = createWrapper();
    const spy = vi.spyOn(client, 'invalidateQueries');
    apiFetchMock.mockResolvedValueOnce({ id: 'w1', isActive: false, claimedAt: 'x' });

    const { result } = renderHook(() => useClaimWarranty(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'w1', claimWoId: 'wo1' });
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/warranties/w1/claim',
      expect.objectContaining({ method: 'POST' }),
    );
    const calls = spy.mock.calls.map(c => JSON.stringify(c[0]?.queryKey ?? c[0]));
    expect(calls).toContain(JSON.stringify(warrantiesKeys.all));
    // Claim знімає гарантію з expiring-вибірки (claimedAt=null фільтр) → віджет мусить оновитись.
    expect(calls).toContain(JSON.stringify(dashboardKeys.expiringWarranties()));
  });
});
