import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { usePaginatedList, type PaginatedResponse } from './usePaginatedList';

export interface WorkOrder {
  id: string;
  orgId?: string;
  number: string;
  status: string;
  priority: string;
  repairCategory?: string | null;
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
