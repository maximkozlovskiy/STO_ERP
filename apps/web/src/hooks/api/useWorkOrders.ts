import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { invalidateWorkOrderSideEffects, patchListItem } from '@/lib/cache-invalidation';
import { usePaginatedList, type PaginatedResponse } from './usePaginatedList';

export interface WorkOrder {
  id: string;
  orgId?: string;
  number: string;
  status: string;
  priority: string;
  repairCategory?: string | null;
  totalLabor: number;
  totalActualLabor: number;
  totalParts: number;
  totalAmount: number;
  totalVat: number;
  paidAmount: number;
  // Мультивалюта (Фаза 3): валюта документа + base-сума + курс. null → історичні/base.
  currencyId?: string | null;
  currencyCode?: string | null;
  totalAmountBase?: number | null;
  rateUsed?: number | null;
  counterpartyId: string;
  counterpartyName?: string;
  contractId?: string | null;
  contractNumber?: string | null;
  vehicleId?: string | null;
  vehicleSummary?: string | null;
  branchId: string;
  branchName?: string;
  plannedAt?: string | null;
  dueDate?: string | null;
  completedAt?: string | null;
  description?: string | null;
  inMileage?: number | null;
  outMileage?: number | null;
  clientApproval?: boolean;
  hasActiveWarranty?: boolean;
  slotStartAt?: string | null;
  slotEndAt?: string | null;
  liftId?: string | null;
  liftName?: string | null;
  slotLiftName?: string | null;
  documentDate?: string | null;
  plannedHours?: number | null;
  actualHours?: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface WorkOrdersFilter extends Record<string, unknown> {
  page?: number;
  limit?: number;
  status?: string;
  priority?: string;
  branchId?: string;
  counterpartyId?: string;
  vehicleId?: string;
  employeeId?: string;
  repairCategory?: string;
  q?: string;
  showDeleted?: boolean;
  include?: string;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

/** @deprecated Use PaginatedResponse<WorkOrder> from usePaginatedList */
export type PaginatedWorkOrders = PaginatedResponse<WorkOrder>;

export const workOrdersKeys = {
  all: ['work-orders'] as const,
  lists: () => [...workOrdersKeys.all, 'list'] as const,
  list: (filters: WorkOrdersFilter) => [...workOrdersKeys.lists(), filters] as const,
  detail: (id: string) => [...workOrdersKeys.all, 'detail', id] as const,
};

export function useWorkOrders(filters: WorkOrdersFilter = {}) {
  return usePaginatedList<WorkOrder>('/work-orders', filters, {
    queryKey: 'work-orders',
  });
}

/**
 * FSM-перехід наряду з ОПТИМІСТИЧНИМ оновленням: badge статусу у видимому списку
 * змінюється миттєво (onMutate патчить кеш), rollback при помилці (наприклад
 * FSM-invalid перехід повертає 400), а onSettled запускає повний cross-cache
 * invalidateWorkOrderSideEffects (перехід рухає й склад, і баланс, і рахунки —
 * рядок міг зникнути/з'явитись у фільтрованому списку).
 */
export function useWorkOrderTransition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiFetch(`/work-orders/${id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      }),
    onMutate: async ({ id, status }) => {
      await qc.cancelQueries({ queryKey: workOrdersKeys.lists() });
      return patchListItem<WorkOrder>(qc, workOrdersKeys.lists(), id, o => ({ ...o, status }));
    },
    onError: (_e, _v, restore) => restore?.(),
    onSettled: () => invalidateWorkOrderSideEffects(qc),
  });
}

/**
 * Soft-delete наряду з ОПТИМІСТИЧНИМ приховуванням рядка (одразу зникає зі списку),
 * rollback при помилці, повна cross-cache інвалідація у onSettled.
 */
export function useDeleteWorkOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/work-orders/${id}`, { method: 'DELETE' }),
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: workOrdersKeys.lists() });
      const snapshots = qc.getQueriesData<PaginatedResponse<WorkOrder>>({
        queryKey: workOrdersKeys.lists(),
      });
      for (const [key, data] of snapshots) {
        if (!data?.items?.some(it => it.id === id)) continue;
        qc.setQueryData<PaginatedResponse<WorkOrder>>(key, {
          ...data,
          items: data.items.filter(it => it.id !== id),
          total: Math.max(0, data.total - 1),
        });
      }
      return () => {
        for (const [key, data] of snapshots) qc.setQueryData(key, data);
      };
    },
    onError: (_e, _v, restore) => restore?.(),
    onSettled: () => invalidateWorkOrderSideEffects(qc),
  });
}
