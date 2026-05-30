import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

export interface WorkOrder {
  id: string;
  number: string;
  status: string;
  priority: string | null;
  repairCategory: string | null;
  totalLabor: number;
  totalParts: number;
  totalAmount: number;
  paidAmount: number;
  counterpartyId: string;
  counterpartyName?: string;
  vehicleId?: string | null;
  vehicleSummary?: string | null;
  branchId: string;
  branchName?: string;
  plannedAt?: string | null;
  dueDate?: string | null;
  description?: string | null;
  inMileage?: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface WorkOrdersFilter {
  page?: number;
  limit?: number;
  status?: string;
  branchId?: string;
  counterpartyId?: string;
  vehicleId?: string;
  employeeId?: string;
  repairCategory?: string;
  q?: string;
  showDeleted?: boolean;
  include?: string;
}

export interface PaginatedWorkOrders {
  items: WorkOrder[];
  total: number;
  page: number;
  limit: number;
}

export const workOrdersKeys = {
  all: ['work-orders'] as const,
  lists: () => [...workOrdersKeys.all, 'list'] as const,
  list: (filters: WorkOrdersFilter) => [...workOrdersKeys.lists(), filters] as const,
  detail: (id: string) => [...workOrdersKeys.all, 'detail', id] as const,
};

export function useWorkOrders(filters: WorkOrdersFilter = {}) {
  const { employee } = useAuth();
  const params = new URLSearchParams();
  if (filters.page) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.status) params.set('status', filters.status);
  if (filters.branchId) params.set('branchId', filters.branchId);
  if (filters.counterpartyId) params.set('counterpartyId', filters.counterpartyId);
  if (filters.vehicleId) params.set('vehicleId', filters.vehicleId);
  if (filters.employeeId) params.set('employeeId', filters.employeeId);
  if (filters.repairCategory) params.set('repairCategory', filters.repairCategory);
  if (filters.q) params.set('q', filters.q);
  if (filters.showDeleted) params.set('showDeleted', 'true');
  if (filters.include) params.set('include', filters.include);
  const qs = params.toString();

  return useQuery<PaginatedWorkOrders>({
    queryKey: workOrdersKeys.list(filters),
    queryFn: ({ signal }) => apiFetch(`/work-orders${qs ? `?${qs}` : ''}`, { signal }),
    enabled: !!employee,
    staleTime: 30_000,
  });
}

export function useWorkOrderTransition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiFetch(`/work-orders/${id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: workOrdersKeys.all }),
  });
}

export function useDeleteWorkOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/work-orders/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: workOrdersKeys.all }),
  });
}
