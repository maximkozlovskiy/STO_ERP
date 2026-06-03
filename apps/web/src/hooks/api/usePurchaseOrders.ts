'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { usePaginatedList, type PaginatedResponse } from './usePaginatedList';

export interface POLine {
  id?: string;
  goodId: string;
  goodName?: string;
  goodSku?: string | null;
  unit?: string;
  unitShortName?: string;
  coefficient?: number;
  quantity: number;
  price: number;
  amount?: number;
  receivedQty?: number;
}

export interface PurchaseOrder {
  id: string;
  orgId?: string;
  number: string;
  status: string;
  supplierId: string;
  supplierName?: string;
  warehouseId: string;
  warehouseName?: string;
  totalAmount: number;
  notes: string | null;
  linesCount: number;
  lines: POLine[];
  documentDate?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

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
    onSuccess: () => qc.invalidateQueries({ queryKey: purchaseOrdersKeys.all }),
  });
}
