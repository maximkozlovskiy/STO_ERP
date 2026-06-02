import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { usePaginatedList, type PaginatedResponse } from './usePaginatedList';

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

export interface CounterpartiesFilter extends Record<string, unknown> {
  page?: number;
  limit?: number;
  type?: string;
  types?: string;
  q?: string;
  showDeleted?: boolean;
}

/** @deprecated Use PaginatedResponse<Counterparty> from usePaginatedList */
export type PaginatedCounterparties = PaginatedResponse<Counterparty>;

export const counterpartiesKeys = {
  all: ['counterparties'] as const,
  lists: () => [...counterpartiesKeys.all, 'list'] as const,
  list: (filters: CounterpartiesFilter) => [...counterpartiesKeys.lists(), filters] as const,
  detail: (id: string) => [...counterpartiesKeys.all, 'detail', id] as const,
};

export function useCounterparties(filters: CounterpartiesFilter = {}) {
  return usePaginatedList<Counterparty>('/counterparties', filters, {
    queryKey: 'counterparties',
  });
}

export function useDeleteCounterparty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/counterparties/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: counterpartiesKeys.all }),
  });
}
