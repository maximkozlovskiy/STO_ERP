import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiSchema } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { usePaginatedList, type PaginatedResponse } from './usePaginatedList';
import { inventoryKeys } from './useInventory';

/**
 * Замовлення постачальнику — ЗГЕНЕРОВАНИЙ тип із OpenAPI.
 * Патерн — docs/PATTERNS.md, «Типи API: беремо згенероване, не пишемо своє».
 *
 * Копія була слабшою:
 *   · `status: string` замість 'DRAFT' | 'ORDERED' | 'RECEIVED' | 'PARTIAL' | 'CANCELLED';
 *   · `deliveryStatus?: string | null` замість union DeliveryStatus;
 *   · `notes: string | null` — у DTO поле ОПЦІЙНЕ (`notes?: string | null`).
 */
export type PurchaseOrder = ApiSchema<'PurchaseOrderResponseDto'>;
export type POLine = ApiSchema<'PurchaseOrderLineResponseDto'>;
export type PurchaseOrderStatusValue = PurchaseOrder['status'];

export interface PurchaseOrdersFilter extends Record<string, unknown> {
  page?: number;
  limit?: number;
  status?: string;
  q?: string;
  showDeleted?: boolean;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

/** @deprecated Use PaginatedResponse<PurchaseOrder> from usePaginatedList */
export type PaginatedPurchaseOrders = PaginatedResponse<PurchaseOrder>;

export const purchaseOrdersKeys = {
  all: ['purchase-orders'] as const,
  lists: () => [...purchaseOrdersKeys.all, 'list'] as const,
  list: (filters: PurchaseOrdersFilter) => [...purchaseOrdersKeys.lists(), filters] as const,
  detail: (id: string) => [...purchaseOrdersKeys.all, 'detail', id] as const,
};

export function usePurchaseOrders(filters: PurchaseOrdersFilter = {}) {
  return usePaginatedList<PurchaseOrder>('/purchase-orders', filters, {
    queryKey: 'purchase-orders',
  });
}

export function useDeletePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/purchase-orders/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: purchaseOrdersKeys.all }),
  });
}

export function useApplyPricing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/purchase-orders/${id}/apply-pricing`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: purchaseOrdersKeys.all });
      // apply-pricing проставляє pricedSalePrice на товари/партії → «Залишки»
      // (inventory) показують застарілу ціну продажу до staleTime без цього.
      void qc.invalidateQueries({ queryKey: inventoryKeys.all });
    },
  });
}
