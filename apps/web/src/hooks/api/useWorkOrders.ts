import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiSchema } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { invalidateWorkOrderSideEffects, patchListItem } from '@/lib/cache-invalidation';
import { usePaginatedList, type PaginatedResponse } from './usePaginatedList';

/**
 * Наряд — ЗГЕНЕРОВАНИЙ тип із OpenAPI (`pnpm run gen:api-types`).
 * Патерн — docs/PATTERNS.md, «Типи API: беремо згенероване, не пишемо своє».
 *
 * Рукописна копія була слабшою за оригінал:
 *   · `status: string` / `priority: string` замість union-енумів;
 *   · `vehicleId?: string | null` — у беку це ОБОВ'ЯЗКОВИЙ `string`
 *     (наряд без авто не існує), тож UI марно ганяв null-перевірки.
 */
export type WorkOrder = ApiSchema<'WorkOrderResponseDto'>;

/** Деталь наряду = список + lines/parts. */
export type WorkOrderDetail = ApiSchema<'WorkOrderDetailDto'>;
export type WorkOrderLine = ApiSchema<'WorkOrderLineResponseDto'>;
export type WorkOrderPart = ApiSchema<'WorkOrderPartResponseDto'>;

/** Статус наряду як union — для exhaustive switch/map у UI. */
export type WorkOrderStatusValue = WorkOrder['status'];

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
    // `status: string` тут був такою самою дірою, як знайдена в Invoice:
    // onMutate писав довільний рядок у кеш списку, і badge міг показати
    // неіснуючий статус до першого refetch. Union зі згенерованого DTO.
    mutationFn: ({ id, status }: { id: string; status: WorkOrderStatusValue }) =>
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
