import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

/**
 * Гарантії наряду. Backend: /warranties (by-work-order / by-counterparty / expiring / create / claim).
 * Єдине джерело типу Warranty — раніше дублювався локально у counterparties PageClient (drift-ризик).
 * Endpoint-и повертають `{items,total}` без пагінації-params → простий useQuery (не usePaginatedList).
 */
export interface Warranty {
  id: string;
  orgId: string;
  workOrderId: string;
  workOrderLineId?: string | null;
  workOrderPartId?: string | null;
  counterpartyId: string;
  workOrderNumber?: string;
  counterpartyName?: string;
  expiresAt: string;
  description: string;
  claimedAt?: string | null;
  claimWoId?: string | null;
  /** обчислюване бекендом: !claimedAt && expiresAt > now */
  isActive: boolean;
  createdAt: string;
}

interface WarrantyList {
  items: Warranty[];
  total: number;
}

export const warrantiesKeys = {
  all: ['warranties'] as const,
  byWorkOrder: (id: string) => [...warrantiesKeys.all, 'by-work-order', id] as const,
  byCounterparty: (id: string) => [...warrantiesKeys.all, 'by-counterparty', id] as const,
  expiring: (days: number) => [...warrantiesKeys.all, 'expiring', days] as const,
};

const OPTS = { staleTime: 60_000, gcTime: 5 * 60_000 } as const;

export function useWarrantiesByWorkOrder(workOrderId: string | null, enabled = true) {
  return useQuery({
    queryKey: warrantiesKeys.byWorkOrder(workOrderId ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<WarrantyList>(`/warranties/by-work-order/${workOrderId}`, { signal }),
    enabled: enabled && !!workOrderId,
    ...OPTS,
  });
}

export function useWarrantiesByCounterparty(counterpartyId: string | null, enabled = true) {
  return useQuery({
    queryKey: warrantiesKeys.byCounterparty(counterpartyId ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<WarrantyList>(`/warranties/by-counterparty/${counterpartyId}`, { signal }),
    enabled: enabled && !!counterpartyId,
    ...OPTS,
  });
}

export function useExpiringWarranties(days = 30, enabled = true) {
  return useQuery({
    queryKey: warrantiesKeys.expiring(days),
    queryFn: ({ signal }) =>
      apiFetch<WarrantyList>(`/warranties/expiring?days=${days}`, { signal }),
    enabled,
    ...OPTS,
  });
}

export interface CreateWarrantyBody {
  workOrderId: string;
  counterpartyId: string;
  expiresAt: string;
  workOrderLineId?: string;
  workOrderPartId?: string;
  description?: string;
}

export function useCreateWarranty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWarrantyBody) =>
      apiFetch<Warranty>('/warranties', { method: 'POST', body: JSON.stringify(body) }),
    // Нова гарантія впливає на список наряду + expiring-віджет + список контрагента.
    onSuccess: () => qc.invalidateQueries({ queryKey: warrantiesKeys.all }),
  });
}

export function useClaimWarranty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, claimWoId }: { id: string; claimWoId: string }) =>
      apiFetch<Warranty>(`/warranties/${id}/claim`, {
        method: 'POST',
        body: JSON.stringify({ claimWoId }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: warrantiesKeys.all }),
  });
}
