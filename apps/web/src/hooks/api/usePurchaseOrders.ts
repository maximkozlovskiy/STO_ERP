import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

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
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface PurchaseOrdersFilter {
  page?: number;
  limit?: number;
  status?: string;
  q?: string;
  showDeleted?: boolean;
}

export interface PaginatedPurchaseOrders {
  items: PurchaseOrder[];
  total: number;
  page: number;
  limit: number;
}

export const purchaseOrdersKeys = {
  all: ['purchase-orders'] as const,
  lists: () => [...purchaseOrdersKeys.all, 'list'] as const,
  list: (filters: PurchaseOrdersFilter) => [...purchaseOrdersKeys.lists(), filters] as const,
  detail: (id: string) => [...purchaseOrdersKeys.all, 'detail', id] as const,
};

export function usePurchaseOrders(filters: PurchaseOrdersFilter = {}) {
  const { employee } = useAuth();
  const params = new URLSearchParams();
  if (filters.page) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.status) params.set('status', filters.status);
  if (filters.q) params.set('q', filters.q);
  if (filters.showDeleted) params.set('showDeleted', 'true');
  const qs = params.toString();

  return useQuery<PaginatedPurchaseOrders>({
    queryKey: purchaseOrdersKeys.list(filters),
    queryFn: ({ signal }) => apiFetch(`/purchase-orders${qs ? `?${qs}` : ''}`, { signal }),
    enabled: !!employee,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
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
