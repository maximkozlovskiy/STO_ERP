import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { displayCounterpartyName } from '@/lib/utils';
import { usePaginatedList, type PaginatedResponse } from './usePaginatedList';

export type CpType = 'CLIENT' | 'SUPPLIER' | 'BOTH';

export interface CounterpartyStatusBadge {
  id: string;
  name: string;
  color: string;
}

export interface Counterparty {
  id: string;
  orgId?: string;
  type: CpType;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  phone: string | null;
  email: string | null;
  edrpou?: string | null;
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
  // Кастомні статуси-мітки (M:N) — присутні лише у detail-відповіді (GET :id), не у списку.
  statuses?: CounterpartyStatusBadge[];
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
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
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

export interface SupplierOption {
  id: string;
  name: string;
}

/** Скільки постачальників тягнемо за раз; більше — пошук за назвою на сервері (Bug #894). */
export const SUPPLIER_OPTIONS_PAGE = 200;

/**
 * Постачальники-контрагенти для вибору (фільтр «Управління купівлями», картка підключення до API
 * постачальника): перші SUPPLIER_OPTIONS_PAGE за абеткою, `q` — пошук на сервері (Bug #894).
 * Комірник читає їх так само (BR-CP-014): сервер віддає йому лише постачальників і поля вибору.
 */
export function useSupplierOptions(q = '', enabled = true) {
  return useQuery<{ items: SupplierOption[]; total: number }>({
    queryKey: [...counterpartiesKeys.all, 'supplier-options', q],
    queryFn: ({ signal }) =>
      apiFetch<{
        items: Array<{
          id: string;
          companyName?: string | null;
          firstName?: string | null;
          lastName?: string | null;
        }>;
        total?: number;
      }>(
        `/counterparties?types=SUPPLIER&types=BOTH&limit=${SUPPLIER_OPTIONS_PAGE}${
          q ? `&q=${encodeURIComponent(q)}` : ''
        }`,
        { signal },
      ).then(r => {
        const items = (r.items ?? []).map(c => ({ id: c.id, name: displayCounterpartyName(c) }));
        return { items, total: r.total ?? items.length };
      }),
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

export function useDeleteCounterparty() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/counterparties/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: counterpartiesKeys.lists() }),
  });
}
