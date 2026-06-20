import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { usePaginatedList, type PaginatedResponse } from './usePaginatedList';

export interface SupplierReturnLine {
  id?: string;
  goodId: string;
  goodName?: string;
  goodSku?: string | null;
  unit?: string;
  unitShortName?: string;
  quantity: number;
  price: number;
  amount: number;
  unitOfMeasureId?: string | null;
}

export interface SupplierReturn {
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
  lines: SupplierReturnLine[];
  documentDate?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface SupplierReturnsFilter extends Record<string, unknown> {
  page?: number;
  limit?: number;
  status?: string;
  q?: string;
  showDeleted?: boolean;
  dateFrom?: string;
  dateTo?: string;
}

/** @deprecated Use PaginatedResponse<SupplierReturn> from usePaginatedList */
export type PaginatedSupplierReturns = PaginatedResponse<SupplierReturn>;

export const supplierReturnsKeys = {
  all: ['supplier-returns'] as const,
  lists: () => [...supplierReturnsKeys.all, 'list'] as const,
  list: (filters: SupplierReturnsFilter) => [...supplierReturnsKeys.lists(), filters] as const,
  detail: (id: string) => [...supplierReturnsKeys.all, 'detail', id] as const,
};

export function useSupplierReturns(filters: SupplierReturnsFilter = {}) {
  return usePaginatedList<SupplierReturn>('/supplier-returns', filters, {
    queryKey: 'supplier-returns',
  });
}

export function useSupplierReturn(id: string | null) {
  return useQuery({
    queryKey: id ? supplierReturnsKeys.detail(id) : ['supplier-returns', 'detail', null],
    queryFn: () => apiFetch<SupplierReturn>(`/supplier-returns/${id}`),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useCreateSupplierReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      supplierId: string;
      warehouseId: string;
      notes?: string;
      documentDate?: string;
      lines?: SupplierReturnLine[];
    }) =>
      apiFetch<SupplierReturn>('/supplier-returns', { method: 'POST', body: JSON.stringify(data) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: supplierReturnsKeys.all });
    },
  });
}

export function useConfirmSupplierReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<SupplierReturn>(`/supplier-returns/${id}/confirm`, { method: 'POST' }),
    onSuccess: (_, id) => {
      void qc.invalidateQueries({ queryKey: supplierReturnsKeys.all });
      void qc.invalidateQueries({ queryKey: supplierReturnsKeys.detail(id) });
    },
  });
}

export function useCancelSupplierReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<SupplierReturn>(`/supplier-returns/${id}/cancel`, { method: 'POST' }),
    onSuccess: (_, id) => {
      void qc.invalidateQueries({ queryKey: supplierReturnsKeys.all });
      void qc.invalidateQueries({ queryKey: supplierReturnsKeys.detail(id) });
    },
  });
}

export function useDeleteSupplierReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/supplier-returns/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: supplierReturnsKeys.all });
    },
  });
}
