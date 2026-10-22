import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { WARRANTY_EXPIRING_DAYS, type ApiSchema, type WarrantyState } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { invalidateWarrantyAffected } from '@/lib/cache-invalidation';

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

/** Рядок списку вкладки «Гарантії» (BR-WAR-001): поля гарантії + авто наряду і стан. */
export type WarrantyListItem = ApiSchema<'WarrantyListItemDto'>;
export type PaginatedWarranties = ApiSchema<'PaginatedWarrantiesDto'>;

export interface WarrantyListFilters {
  page: number;
  limit: number;
  q?: string;
  states?: WarrantyState[];
  sortBy?: 'expiresAt' | 'createdAt';
  sortDir?: 'asc' | 'desc';
  /** Лише ця гарантія — для посилання з «Пов'язаних документів». */
  id?: string;
}

export const warrantiesKeys = {
  all: ['warranties'] as const,
  lists: () => [...warrantiesKeys.all, 'list'] as const,
  list: (f: WarrantyListFilters) => [...warrantiesKeys.lists(), f] as const,
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

export function warrantyListPath(f: WarrantyListFilters): string {
  const params = new URLSearchParams({ page: String(f.page), limit: String(f.limit) });
  if (f.q) params.set('q', f.q);
  if (f.states?.length) params.set('state', f.states.join(','));
  if (f.sortBy) params.set('sortBy', f.sortBy);
  if (f.sortDir) params.set('sortDir', f.sortDir);
  if (f.id) params.set('id', f.id);
  return `/warranties?${params}`;
}

/** BR-WAR-001: список вкладки «Гарантії». `enabled` — гейт за роллю (GET лише для 4 ролей). */
export function useWarrantyList(filters: WarrantyListFilters, enabled = true) {
  return useQuery({
    queryKey: warrantiesKeys.list(filters),
    queryFn: ({ signal }) => apiFetch<PaginatedWarranties>(warrantyListPath(filters), { signal }),
    enabled,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useExpiringWarranties(days = WARRANTY_EXPIRING_DAYS, enabled = true) {
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
    // Нова гарантія впливає на список наряду + список контрагента + дашборд-віджет
    // «Гарантії, що закінчуються» (окремий ключ dashboardKeys.expiringWarranties).
    onSuccess: () => invalidateWarrantyAffected(qc),
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
    // Claim переводить гарантію з isActive→claimed: списки гарантій І дашборд-віджет
    // (expiring читає лише claimedAt=null) мають оновитись, інакше claimed-гарантія
    // висить у віджеті до staleTime (Bug #718).
    onSuccess: () => invalidateWarrantyAffected(qc),
  });
}
