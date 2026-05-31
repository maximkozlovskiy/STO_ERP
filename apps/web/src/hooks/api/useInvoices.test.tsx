import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

// Mock apiFetch — useInvoices викликає GET /invoices, POST /payments, тощо.
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// Mock useAuth — useInvoices використовує employee для enabled-gate.
const useAuthMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  useAuth: () => useAuthMock(),
}));

import {
  useInvoices,
  invoicesKeys,
  useCreatePayment,
  useDeleteInvoice,
  useInvoiceTransition,
} from './useInvoices';
import { counterpartiesKeys } from './useCounterparties';

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe('useInvoices', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    useAuthMock.mockReset();
    apiFetchMock.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });
  });

  describe('invoicesKeys factory', () => {
    it('all → ["invoices"]', () => {
      expect(invoicesKeys.all).toEqual(['invoices']);
    });
    it('lists() → ["invoices", "list"]', () => {
      expect(invoicesKeys.lists()).toEqual(['invoices', 'list']);
    });
    it('list(filters) інкапсулює фільтри у ключ — різні фільтри = різні ключі', () => {
      const k1 = invoicesKeys.list({ status: 'DRAFT' });
      const k2 = invoicesKeys.list({ status: 'PAID' });
      expect(JSON.stringify(k1)).not.toEqual(JSON.stringify(k2));
    });
    it('detail(id) → ["invoices", "detail", id]', () => {
      expect(invoicesKeys.detail('abc')).toEqual(['invoices', 'detail', 'abc']);
    });
  });

  describe('enabled gate', () => {
    it('НЕ викликає apiFetch якщо employee=null', async () => {
      useAuthMock.mockReturnValue({ employee: null });
      const { wrapper } = createWrapper();
      renderHook(() => useInvoices({}), { wrapper });
      await new Promise(r => setTimeout(r, 50));
      expect(apiFetchMock).not.toHaveBeenCalled();
    });

    it('викликає apiFetch коли employee присутній', async () => {
      useAuthMock.mockReturnValue({ employee: { id: 'emp-1', role: 'OWNER' } });
      const { wrapper } = createWrapper();
      renderHook(() => useInvoices({}), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    });
  });

  describe('URLSearchParams побудова', () => {
    beforeEach(() => {
      useAuthMock.mockReturnValue({ employee: { id: 'emp-1', role: 'OWNER' } });
    });

    it('передає status у query string', async () => {
      const { wrapper } = createWrapper();
      renderHook(() => useInvoices({ status: 'DRAFT' }), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url = apiFetchMock.mock.calls[0][0] as string;
      expect(url).toContain('status=DRAFT');
    });

    it('передає page, limit, counterpartyId одночасно', async () => {
      const { wrapper } = createWrapper();
      renderHook(() => useInvoices({ page: 2, limit: 50, counterpartyId: 'cp-1' }), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url = apiFetchMock.mock.calls[0][0] as string;
      expect(url).toContain('page=2');
      expect(url).toContain('limit=50');
      expect(url).toContain('counterpartyId=cp-1');
    });

    it('передає workOrderId і q одночасно', async () => {
      const { wrapper } = createWrapper();
      renderHook(() => useInvoices({ workOrderId: 'wo-1', q: 'BMW' }), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url = apiFetchMock.mock.calls[0][0] as string;
      expect(url).toContain('workOrderId=wo-1');
      expect(url).toContain('q=BMW');
    });

    it('БЕЗ фільтрів → URL без query string', async () => {
      const { wrapper } = createWrapper();
      renderHook(() => useInvoices({}), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url = apiFetchMock.mock.calls[0][0] as string;
      expect(url).toBe('/invoices');
    });

    it('showDeleted=true → showDeleted=true; false → відсутній', async () => {
      const { wrapper } = createWrapper();
      renderHook(() => useInvoices({ showDeleted: true }), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url1 = apiFetchMock.mock.calls[0][0] as string;
      expect(url1).toContain('showDeleted=true');

      apiFetchMock.mockClear();
      const { wrapper: w2 } = createWrapper();
      renderHook(() => useInvoices({ showDeleted: false }), { wrapper: w2 });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url2 = apiFetchMock.mock.calls[0][0] as string;
      expect(url2).not.toContain('showDeleted');
    });
  });

  describe('signal abort', () => {
    it('передає AbortSignal у apiFetch (race-protection)', async () => {
      useAuthMock.mockReturnValue({ employee: { id: 'emp-1', role: 'OWNER' } });
      const { wrapper } = createWrapper();
      renderHook(() => useInvoices({}), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const init = apiFetchMock.mock.calls[0][1] as { signal?: AbortSignal };
      expect(init).toBeDefined();
      expect(init.signal).toBeDefined();
    });
  });

  describe('useCreatePayment cross-resource invalidation (Bug #245)', () => {
    it('після успішного POST /payments інвалідує invoices, work-orders і counterparties', async () => {
      useAuthMock.mockReturnValue({ employee: { id: 'emp-1', role: 'OWNER' } });
      apiFetchMock.mockResolvedValueOnce({ id: 'pay-1' });
      const { client, wrapper } = createWrapper();
      const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

      const { result } = renderHook(() => useCreatePayment(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync({ amount: 100, counterpartyId: 'cp-1' });
      });

      // Bug #245: ОБОВ'ЯЗКОВО три invalidate-виклики — без counterpartiesKeys.all
      // CRM-list показує стале currentBalance до staleTime=30s.
      const calls = invalidateSpy.mock.calls.map(c => JSON.stringify(c[0]?.queryKey));
      expect(calls).toContain(JSON.stringify(invoicesKeys.all));
      expect(calls).toContain(JSON.stringify(['work-orders']));
      expect(calls).toContain(JSON.stringify(counterpartiesKeys.all));
    });
  });

  describe('useDeleteInvoice', () => {
    it('викликає DELETE /invoices/:id і інвалідує invoicesKeys.all', async () => {
      useAuthMock.mockReturnValue({ employee: { id: 'emp-1', role: 'OWNER' } });
      apiFetchMock.mockResolvedValueOnce(undefined);
      const { client, wrapper } = createWrapper();
      const invalidateSpy = vi.spyOn(client, 'invalidateQueries');

      const { result } = renderHook(() => useDeleteInvoice(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync('inv-1');
      });

      expect(apiFetchMock).toHaveBeenCalledWith('/invoices/inv-1', { method: 'DELETE' });
      const calls = invalidateSpy.mock.calls.map(c => JSON.stringify(c[0]?.queryKey));
      expect(calls).toContain(JSON.stringify(invoicesKeys.all));
    });
  });

  describe('useInvoiceTransition', () => {
    it('викликає POST /invoices/:id/transition з body { status }', async () => {
      useAuthMock.mockReturnValue({ employee: { id: 'emp-1', role: 'OWNER' } });
      apiFetchMock.mockResolvedValueOnce({ id: 'inv-1', status: 'SENT' });
      const { wrapper } = createWrapper();

      const { result } = renderHook(() => useInvoiceTransition(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync({ id: 'inv-1', status: 'SENT' });
      });

      expect(apiFetchMock).toHaveBeenCalledWith('/invoices/inv-1/transition', {
        method: 'POST',
        body: JSON.stringify({ status: 'SENT' }),
      });
    });
  });
});
