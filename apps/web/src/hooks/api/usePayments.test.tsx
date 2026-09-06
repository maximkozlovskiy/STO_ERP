import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

// Mock apiFetch — hooks викликають /payments endpoints.
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// usePaginatedList використовує useAuth для enabled-gate.
const useAuthMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  useAuth: () => useAuthMock(),
}));

import { paymentsKeys, usePayments, usePayment, useRetryFiscal } from './usePayments';
import { counterpartiesKeys } from './useCounterparties';

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe('usePayments hooks (Phase 2)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    useAuthMock.mockReset();
    apiFetchMock.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });
  });

  describe('paymentsKeys factory', () => {
    it('all → ["payments"]', () => {
      expect(paymentsKeys.all).toEqual(['payments']);
    });
    it('lists() → ["payments", "list"]', () => {
      expect(paymentsKeys.lists()).toEqual(['payments', 'list']);
    });
    it('list(filters) різні фільтри = різні ключі', () => {
      const k1 = paymentsKeys.list({ fiscalStatus: 'FAILED' });
      const k2 = paymentsKeys.list({ fiscalStatus: 'none' });
      expect(JSON.stringify(k1)).not.toEqual(JSON.stringify(k2));
    });
    it('detail(id) → ["payments", "detail", id]', () => {
      expect(paymentsKeys.detail('abc')).toEqual(['payments', 'detail', 'abc']);
    });
  });

  describe('usePayments (list)', () => {
    it('gated by employee (enabled=false без employee)', async () => {
      useAuthMock.mockReturnValue({ employee: null });
      const { wrapper } = createWrapper();
      renderHook(() => usePayments(), { wrapper });
      await new Promise(r => setTimeout(r, 20));
      expect(apiFetchMock).not.toHaveBeenCalled();
    });

    it('передає всі фільтри у URL query string (date-range, method, fiscalStatus)', async () => {
      useAuthMock.mockReturnValue({ employee: { id: '1' } });
      const { wrapper } = createWrapper();
      renderHook(
        () =>
          usePayments({
            page: 2,
            limit: 20,
            method: 'card',
            fiscalStatus: 'FAILED',
            dateFrom: '2026-09-01',
            dateTo: '2026-09-06',
          }),
        { wrapper },
      );
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url = apiFetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('/payments');
      expect(url).toContain('page=2');
      expect(url).toContain('method=card');
      expect(url).toContain('fiscalStatus=FAILED');
      expect(url).toContain('dateFrom=2026-09-01');
      expect(url).toContain('dateTo=2026-09-06');
    });

    it("fiscalStatus='none' проходить у query (без фіскалізації, не дропається як empty)", async () => {
      useAuthMock.mockReturnValue({ employee: { id: '1' } });
      const { wrapper } = createWrapper();
      renderHook(() => usePayments({ fiscalStatus: 'none' }), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url = apiFetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('fiscalStatus=none');
    });
  });

  describe('usePayment (detail)', () => {
    it('id=null → enabled=false, apiFetch НЕ викликається', async () => {
      const { wrapper } = createWrapper();
      renderHook(() => usePayment(null), { wrapper });
      await new Promise(r => setTimeout(r, 20));
      expect(apiFetchMock).not.toHaveBeenCalled();
    });

    it('id → GET /payments/:id', async () => {
      apiFetchMock.mockResolvedValueOnce({ id: 'p1', amount: 500 });
      const { wrapper } = createWrapper();
      renderHook(() => usePayment('p1'), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/payments/p1'));
    });
  });

  describe('useRetryFiscal', () => {
    it('POST /payments/:id/retry-fiscal + інвалідує payments.all + detail(id) + counterparties.all', async () => {
      const { client, wrapper } = createWrapper();
      const spy = vi.spyOn(client, 'invalidateQueries');
      apiFetchMock.mockResolvedValueOnce({ id: 'p1', fiscalStatus: 'QUEUED' });

      const { result } = renderHook(() => useRetryFiscal(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync('p1');
      });

      expect(apiFetchMock).toHaveBeenCalledWith(
        '/payments/p1/retry-fiscal',
        expect.objectContaining({ method: 'POST' }),
      );
      const calls = spy.mock.calls.map(c => JSON.stringify(c[0]?.queryKey ?? c[0]));
      expect(calls).toContain(JSON.stringify(paymentsKeys.all));
      expect(calls).toContain(JSON.stringify(paymentsKeys.detail('p1')));
      // retry змінює fiscalStatus, але баланс не чіпає — проте invalidate counterparties
      // лишається (дзеркалить supplier-payments): не режим-критично, але guard від drift.
      expect(calls).toContain(JSON.stringify(counterpartiesKeys.all));
    });
  });
});
