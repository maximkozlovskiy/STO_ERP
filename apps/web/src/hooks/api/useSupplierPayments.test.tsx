import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

// Mock apiFetch — hooks викликають /supplier-payments endpoints.
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// usePaginatedList використовує useAuth для enabled-gate.
const useAuthMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  useAuth: () => useAuthMock(),
}));

import {
  supplierPaymentsKeys,
  useSupplierPayments,
  useCreateSupplierPayment,
  useConfirmSupplierPayment,
  useCancelSupplierPayment,
  useDeleteSupplierPayment,
  useSupplierPaymentDocuments,
} from './useSupplierPayments';
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

describe('useSupplierPayments', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    useAuthMock.mockReset();
    apiFetchMock.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });
  });

  describe('supplierPaymentsKeys factory', () => {
    it('all → ["supplier-payments"]', () => {
      expect(supplierPaymentsKeys.all).toEqual(['supplier-payments']);
    });
    it('lists() → ["supplier-payments", "list"]', () => {
      expect(supplierPaymentsKeys.lists()).toEqual(['supplier-payments', 'list']);
    });
    it('list(filters) інкапсулює фільтри у ключ — різні фільтри = різні ключі', () => {
      const k1 = supplierPaymentsKeys.list({ status: 'DRAFT' });
      const k2 = supplierPaymentsKeys.list({ status: 'CONFIRMED' });
      expect(JSON.stringify(k1)).not.toEqual(JSON.stringify(k2));
    });
    it('detail(id) → ["supplier-payments", "detail", id]', () => {
      expect(supplierPaymentsKeys.detail('abc')).toEqual(['supplier-payments', 'detail', 'abc']);
    });
  });

  describe('useSupplierPayments (list)', () => {
    it('gated by employee (enabled=false без employee)', async () => {
      useAuthMock.mockReturnValue({ employee: null });
      const { wrapper } = createWrapper();
      renderHook(() => useSupplierPayments(), { wrapper });
      // Без employee useAuth → enabled=false → apiFetch НЕ викликається
      await new Promise(r => setTimeout(r, 20));
      expect(apiFetchMock).not.toHaveBeenCalled();
    });

    it('передає фільтри у URL query string', async () => {
      useAuthMock.mockReturnValue({ employee: { id: '1' } });
      const { wrapper } = createWrapper();
      renderHook(
        () =>
          useSupplierPayments({
            page: 2,
            limit: 20,
            status: 'DRAFT',
            supplierId: '11111111-1111-4111-8111-111111111111',
            q: 'ОПП',
            dateFrom: '2026-07-01',
            dateTo: '2026-07-31',
          }),
        { wrapper },
      );
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url = apiFetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('/supplier-payments');
      expect(url).toContain('page=2');
      expect(url).toContain('status=DRAFT');
      expect(url).toContain('supplierId=11111111-1111-4111-8111-111111111111');
      expect(url).toContain('q=%D0%9E%D0%9F%D0%9F');
      expect(url).toContain('dateFrom=2026-07-01');
      expect(url).toContain('dateTo=2026-07-31');
    });
  });

  describe('useCreateSupplierPayment', () => {
    it('POST /supplier-payments з body та інвалідує supplierPaymentsKeys.all після успіху', async () => {
      const { client, wrapper } = createWrapper();
      const spy = vi.spyOn(client, 'invalidateQueries');
      apiFetchMock.mockResolvedValueOnce({
        id: 'sp1',
        number: 'ОПП-1',
        status: 'DRAFT',
      });

      const { result } = renderHook(() => useCreateSupplierPayment(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync({
          supplierId: 's1',
          sourceType: 'CASH_REGISTER',
          cashRegisterId: 'cr1',
          amount: 100,
          method: 'cash',
        });
      });

      expect(apiFetchMock).toHaveBeenCalledWith(
        '/supplier-payments',
        expect.objectContaining({ method: 'POST' }),
      );
      const calls = spy.mock.calls.map(c => JSON.stringify(c[0]?.queryKey ?? c[0]));
      expect(calls).toContain(JSON.stringify(supplierPaymentsKeys.all));
    });
  });

  describe('useConfirmSupplierPayment (Bug #590 regression)', () => {
    it('POST /supplier-payments/:id/confirm інвалідує supplierPayments.all + detail(id) + counterparties.all', async () => {
      const { client, wrapper } = createWrapper();
      const spy = vi.spyOn(client, 'invalidateQueries');
      apiFetchMock.mockResolvedValueOnce({ id: 'sp1', status: 'CONFIRMED' });

      const { result } = renderHook(() => useConfirmSupplierPayment(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync('sp1');
      });

      expect(apiFetchMock).toHaveBeenCalledWith(
        '/supplier-payments/sp1/confirm',
        expect.objectContaining({ method: 'POST' }),
      );
      const calls = spy.mock.calls.map(c => JSON.stringify(c[0]?.queryKey ?? c[0]));
      expect(calls).toContain(JSON.stringify(supplierPaymentsKeys.all));
      expect(calls).toContain(JSON.stringify(supplierPaymentsKeys.detail('sp1')));
      // Bug #590: confirm пише settlement PAYMENT → баланс постачальника змінюється →
      // ОБОВ'ЯЗКОВО інвалідувати counterparties (CRM balance, dossier balance).
      // Без цього refactor що видалить invalidate пройде CI зеленим — silent UX stale.
      expect(calls).toContain(JSON.stringify(counterpartiesKeys.all));
    });
  });

  describe('useCancelSupplierPayment', () => {
    it('POST /supplier-payments/:id/cancel інвалідує supplierPayments.all + detail(id)', async () => {
      const { client, wrapper } = createWrapper();
      const spy = vi.spyOn(client, 'invalidateQueries');
      apiFetchMock.mockResolvedValueOnce({ id: 'sp1', status: 'CANCELLED' });

      const { result } = renderHook(() => useCancelSupplierPayment(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync('sp1');
      });

      expect(apiFetchMock).toHaveBeenCalledWith(
        '/supplier-payments/sp1/cancel',
        expect.objectContaining({ method: 'POST' }),
      );
      const calls = spy.mock.calls.map(c => JSON.stringify(c[0]?.queryKey ?? c[0]));
      expect(calls).toContain(JSON.stringify(supplierPaymentsKeys.all));
      expect(calls).toContain(JSON.stringify(supplierPaymentsKeys.detail('sp1')));
      // cancel() з DRAFT НЕ пише settlement — counterparties навмисно НЕ інвалідується
      // щоб уникнути зайвих refetch на CRM (LOW noise, high volume у workflow).
      expect(calls).not.toContain(JSON.stringify(counterpartiesKeys.all));
    });
  });

  describe('useDeleteSupplierPayment', () => {
    it('DELETE /supplier-payments/:id інвалідує supplierPaymentsKeys.all', async () => {
      const { client, wrapper } = createWrapper();
      const spy = vi.spyOn(client, 'invalidateQueries');
      apiFetchMock.mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useDeleteSupplierPayment(), { wrapper });
      await act(async () => {
        await result.current.mutateAsync('sp1');
      });

      expect(apiFetchMock).toHaveBeenCalledWith(
        '/supplier-payments/sp1',
        expect.objectContaining({ method: 'DELETE' }),
      );
      const calls = spy.mock.calls.map(c => JSON.stringify(c[0]?.queryKey ?? c[0]));
      expect(calls).toContain(JSON.stringify(supplierPaymentsKeys.all));
    });
  });

  describe('useSupplierPaymentDocuments (drill-down)', () => {
    it('params=null → enabled=false, apiFetch НЕ викликається (клітинку не клікнуто)', async () => {
      useAuthMock.mockReturnValue({ employee: { id: '1' } });
      const { wrapper } = createWrapper();
      renderHook(() => useSupplierPaymentDocuments(null), { wrapper });
      await new Promise(r => setTimeout(r, 20));
      expect(apiFetchMock).not.toHaveBeenCalled();
    });

    it('date-params → GET з date + supplierId у query', async () => {
      useAuthMock.mockReturnValue({ employee: { id: '1' } });
      apiFetchMock.mockResolvedValueOnce([]);
      const { wrapper } = createWrapper();
      renderHook(
        () =>
          useSupplierPaymentDocuments({
            from: '2026-09-02',
            to: '2026-09-21',
            date: '2026-09-08',
            supplierId: 'sup-1',
          }),
        { wrapper },
      );
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url = apiFetchMock.mock.calls[0][0] as string;
      expect(url).toContain('/supplier-payments/schedule/documents?');
      expect(url).toContain('date=2026-09-08');
      expect(url).toContain('supplierId=sup-1');
      expect(url).not.toContain('target=');
    });

    it('target-params без supplierId → GET з target, без supplierId (рядок «Разом»)', async () => {
      useAuthMock.mockReturnValue({ employee: { id: '1' } });
      apiFetchMock.mockResolvedValueOnce([]);
      const { wrapper } = createWrapper();
      renderHook(
        () =>
          useSupplierPaymentDocuments({ from: '2026-09-02', to: '2026-09-21', target: 'overdue' }),
        { wrapper },
      );
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url = apiFetchMock.mock.calls[0][0] as string;
      expect(url).toContain('target=overdue');
      expect(url).not.toContain('supplierId=');
      expect(url).not.toContain('date=');
    });
  });
});
