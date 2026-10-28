// useWarranties — гарантії наряду/контрагента.
// Bug #718 regression: create/claim мутації інвалідують `warrantiesKeys.all` (списки наряду й
// контрагента). Дашборд-віджета «Гарантії, що закінчуються» з 2026-10-29 немає.
import { renderHook, act, waitFor } from '@testing-library/react';
import { WARRANTY_EXPIRING_DAYS } from '@sto/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import {
  warrantiesKeys,
  useCreateWarranty,
  useClaimWarranty,
  useExpiringWarranties,
  warrantyListPath,
} from './useWarranties';

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

  it('useCreateWarranty → POST /warranties + інвалідує warranties.all', async () => {
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
  });

  it('useClaimWarranty → POST /:id/claim + інвалідує warranties.all', async () => {
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
  });
});

describe('Список вкладки «Гарантії» і поріг «закінчується»', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ items: [], total: 0 });
  });

  // guards: BR-WAR-005
  it('warrantyListPath: стани через кому, порожні параметри не шлються', () => {
    expect(warrantyListPath({ page: 2, limit: 20 })).toBe('/warranties?page=2&limit=20');
    expect(
      warrantyListPath({
        page: 1,
        limit: 20,
        q: 'AA12',
        states: ['ACTIVE', 'EXPIRING'],
        sortBy: 'expiresAt',
        sortDir: 'asc',
        id: 'w1',
      }),
    ).toBe(
      '/warranties?page=1&limit=20&q=AA12&state=ACTIVE%2CEXPIRING&sortBy=expiresAt&sortDir=asc&id=w1',
    );
  });

  // guards: BR-WAR-002
  it('useExpiringWarranties бере поріг WARRANTY_EXPIRING_DAYS', async () => {
    const { wrapper } = createWrapper();
    renderHook(() => useExpiringWarranties(), { wrapper });

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
    expect(String(apiFetchMock.mock.calls[0][0])).toBe(
      `/warranties/expiring?days=${WARRANTY_EXPIRING_DAYS}`,
    );
  });
});
