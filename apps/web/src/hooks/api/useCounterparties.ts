import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

export interface Counterparty {
  id: string;
  orgId?: string;
  type: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  phone: string | null;
  email: string | null;
  edrpou: string | null;
  vatPayer: boolean;
  balance: number;
  notes?: string | null;
  legalForm?: string | null;
  legalAddress?: string | null;
  actualAddress?: string | null;
  bankAccount?: string | null;
  bankName?: string | null;
  contactPerson?: string | null;
  taxNumber?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CounterpartiesFilter {
  page?: number;
  limit?: number;
  type?: string;
  types?: string;
  q?: string;
  showDeleted?: boolean;
}

export interface PaginatedCounterparties {
  items: Counterparty[];
  total: number;
  page: number;
  limit: number;
}

export const counterpartiesKeys = {
  all: ['counterparties'] as const,
  lists: () => [...counterpartiesKeys.all, 'list'] as const,
  list: (filters: CounterpartiesFilter) => [...counterpartiesKeys.lists(), filters] as const,
  detail: (id: string) => [...counterpartiesKeys.all, 'detail', id] as const,
};

export function useCounterparties(filters: CounterpartiesFilter = {}) {
  const { employee } = useAuth();
  const params = new URLSearchParams();
  if (filters.page) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.type) params.set('type', filters.type);
  if (filters.types) params.set('types', filters.types);
  if (filters.q) params.set('q', filters.q);
  if (filters.showDeleted) params.set('showDeleted', 'true');
  const qs = params.toString();

  return useQuery<PaginatedCounterparties>({
    queryKey: counterpartiesKeys.list(filters),
    queryFn: ({ signal }) => apiFetch(`/counterparties${qs ? `?${qs}` : ''}`, { signal }),
    enabled: !!employee,
    staleTime: 30_000,
  });
}

export function useDeleteCounterparty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/counterparties/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: counterpartiesKeys.all }),
  });
}
