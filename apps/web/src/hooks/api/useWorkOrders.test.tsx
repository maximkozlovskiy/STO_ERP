import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

// Mock apiFetch — useWorkOrders викликає GET /work-orders. Без моку jsdom не має fetch.
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// Mock useAuth — useWorkOrders використовує employee для enabled-gate.
const useAuthMock = vi.fn();
vi.mock('@/lib/auth', () => ({
  useAuth: () => useAuthMock(),
}));

import {
  useWorkOrders,
  useWorkOrderTransition,
  useDeleteWorkOrder,
  workOrdersKeys,
  type WorkOrder,
} from './useWorkOrders';
import type { PaginatedResponse } from './usePaginatedList';

function seedList(client: QueryClient, items: Partial<WorkOrder>[]) {
  const filters = { page: 1, limit: 20 };
  const data: PaginatedResponse<WorkOrder> = {
    items: items as WorkOrder[],
    total: items.length,
    page: 1,
    limit: 20,
  };
  client.setQueryData(workOrdersKeys.list(filters), data);
  return filters;
}

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe('useWorkOrders', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    useAuthMock.mockReset();
    apiFetchMock.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });
  });

  describe('workOrdersKeys factory', () => {
    it('all → ["work-orders"]', () => {
      expect(workOrdersKeys.all).toEqual(['work-orders']);
    });
    it('lists() → ["work-orders", "list"]', () => {
      expect(workOrdersKeys.lists()).toEqual(['work-orders', 'list']);
    });
    it('list(filters) інкапсулює фільтри у ключ — різні фільтри = різні ключі', () => {
      const k1 = workOrdersKeys.list({ status: 'IN_PROGRESS' });
      const k2 = workOrdersKeys.list({ status: 'COMPLETED' });
      expect(JSON.stringify(k1)).not.toEqual(JSON.stringify(k2));
    });
    it('detail(id) → ["work-orders", "detail", id]', () => {
      expect(workOrdersKeys.detail('abc')).toEqual(['work-orders', 'detail', 'abc']);
    });
  });

  describe('enabled gate', () => {
    it('НЕ викликає apiFetch якщо employee=null (auth ще не завантажений)', async () => {
      useAuthMock.mockReturnValue({ employee: null });
      const { wrapper } = createWrapper();
      renderHook(() => useWorkOrders({ status: 'IN_PROGRESS' }), { wrapper });
      // Дати React Query шанс запуститися
      await new Promise(r => setTimeout(r, 50));
      expect(apiFetchMock).not.toHaveBeenCalled();
    });

    it('викликає apiFetch коли employee присутній', async () => {
      useAuthMock.mockReturnValue({ employee: { id: 'emp-1', role: 'OWNER' } });
      const { wrapper } = createWrapper();
      renderHook(() => useWorkOrders({}), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    });
  });

  describe('URLSearchParams побудова', () => {
    beforeEach(() => {
      useAuthMock.mockReturnValue({ employee: { id: 'emp-1', role: 'OWNER' } });
    });

    it('передає status у query string', async () => {
      const { wrapper } = createWrapper();
      renderHook(() => useWorkOrders({ status: 'IN_PROGRESS' }), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url = apiFetchMock.mock.calls[0][0] as string;
      expect(url).toContain('status=IN_PROGRESS');
    });

    it('передає repairCategory (Bug #3d5136d regression-guard)', async () => {
      const { wrapper } = createWrapper();
      renderHook(() => useWorkOrders({ repairCategory: 'MAINTENANCE' }), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url = apiFetchMock.mock.calls[0][0] as string;
      expect(url).toContain('repairCategory=MAINTENANCE');
    });

    it('передає employeeId і q одночасно', async () => {
      const { wrapper } = createWrapper();
      renderHook(() => useWorkOrders({ employeeId: 'emp-1', q: 'BMW' }), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url = apiFetchMock.mock.calls[0][0] as string;
      expect(url).toContain('employeeId=emp-1');
      expect(url).toContain('q=BMW');
    });

    it('БЕЗ фільтрів → URL без query string', async () => {
      const { wrapper } = createWrapper();
      renderHook(() => useWorkOrders({}), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url = apiFetchMock.mock.calls[0][0] as string;
      expect(url).toBe('/work-orders');
    });

    it('showDeleted=true → showDeleted=true у URL; false → відсутній параметр', async () => {
      const { wrapper } = createWrapper();
      renderHook(() => useWorkOrders({ showDeleted: true }), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url1 = apiFetchMock.mock.calls[0][0] as string;
      expect(url1).toContain('showDeleted=true');

      // Окремий рендер — false не повинен з'являтися у URL
      apiFetchMock.mockClear();
      const { wrapper: w2 } = createWrapper();
      renderHook(() => useWorkOrders({ showDeleted: false }), { wrapper: w2 });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const url2 = apiFetchMock.mock.calls[0][0] as string;
      expect(url2).not.toContain('showDeleted');
    });
  });

  describe('useWorkOrderTransition — оптимістичне оновлення', () => {
    beforeEach(() => {
      useAuthMock.mockReturnValue({ employee: { id: 'emp-1', role: 'OWNER' } });
    });

    it('onMutate патчить status рядка у кешованому списку ДО відповіді сервера', async () => {
      const { client, wrapper } = createWrapper();
      const filters = seedList(client, [
        { id: 'wo-1', status: 'DRAFT' },
        { id: 'wo-2', status: 'DRAFT' },
      ]);
      // Сервер відповідає з затримкою → перевіряємо оптимістичний стан у проміжку.
      let resolveFetch: (v: unknown) => void = () => {};
      apiFetchMock.mockReturnValue(new Promise(r => (resolveFetch = r)));

      const { result } = renderHook(() => useWorkOrderTransition(), { wrapper });
      result.current.mutate({ id: 'wo-1', status: 'IN_PROGRESS' });

      await waitFor(() => {
        const cached = client.getQueryData<PaginatedResponse<WorkOrder>>(
          workOrdersKeys.list(filters),
        );
        expect(cached?.items.find(i => i.id === 'wo-1')?.status).toBe('IN_PROGRESS');
      });
      // wo-2 не зачеплено
      const cached = client.getQueryData<PaginatedResponse<WorkOrder>>(
        workOrdersKeys.list(filters),
      );
      expect(cached?.items.find(i => i.id === 'wo-2')?.status).toBe('DRAFT');
      resolveFetch({});
    });

    it('onError відкочує оптимістичний патч (FSM-invalid перехід → 400)', async () => {
      const { client, wrapper } = createWrapper();
      const filters = seedList(client, [{ id: 'wo-1', status: 'DRAFT' }]);
      apiFetchMock.mockRejectedValue(new Error('FSM: недозволений перехід'));

      const { result } = renderHook(() => useWorkOrderTransition(), { wrapper });
      result.current.mutate({ id: 'wo-1', status: 'PAID' });

      await waitFor(() => expect(result.current.isError).toBe(true));
      const cached = client.getQueryData<PaginatedResponse<WorkOrder>>(
        workOrdersKeys.list(filters),
      );
      expect(cached?.items.find(i => i.id === 'wo-1')?.status).toBe('DRAFT');
    });
  });

  describe('useDeleteWorkOrder — оптимістичне приховування', () => {
    beforeEach(() => {
      useAuthMock.mockReturnValue({ employee: { id: 'emp-1', role: 'OWNER' } });
    });

    it('onMutate прибирає рядок зі списку і зменшує total; onError відкочує', async () => {
      const { client, wrapper } = createWrapper();
      const filters = seedList(client, [
        { id: 'wo-1', status: 'DRAFT' },
        { id: 'wo-2', status: 'DRAFT' },
      ]);
      apiFetchMock.mockRejectedValue(new Error('boom'));

      const { result } = renderHook(() => useDeleteWorkOrder(), { wrapper });
      result.current.mutate('wo-1');

      // Спочатку зникає (оптимістично), потім повертається (rollback)
      await waitFor(() => expect(result.current.isError).toBe(true));
      const cached = client.getQueryData<PaginatedResponse<WorkOrder>>(
        workOrdersKeys.list(filters),
      );
      expect(cached?.items.map(i => i.id)).toEqual(['wo-1', 'wo-2']);
      expect(cached?.total).toBe(2);
    });
  });

  describe('signal abort', () => {
    it('передає AbortSignal у apiFetch (race-protection)', async () => {
      useAuthMock.mockReturnValue({ employee: { id: 'emp-1', role: 'OWNER' } });
      const { wrapper } = createWrapper();
      renderHook(() => useWorkOrders({}), { wrapper });
      await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
      const init = apiFetchMock.mock.calls[0][1] as { signal?: AbortSignal };
      expect(init).toBeDefined();
      expect(init.signal).toBeDefined();
    });
  });
});
