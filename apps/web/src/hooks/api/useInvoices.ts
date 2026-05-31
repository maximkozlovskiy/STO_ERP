import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { counterpartiesKeys } from './useCounterparties';

export interface Invoice {
  id: string;
  orgId?: string;
  number: string;
  status: string;
  amount: number;
  totalWithoutVat?: number | null;
  totalVat?: number | null;
  totalWithVat?: number | null;
  invoiceType?: string | null;
  counterpartyId: string;
  counterpartyName?: string;
  workOrderId?: string | null;
  workOrderNumber?: string | null;
  paidAmount?: number | null;
  dueDate?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface InvoicesFilter {
  page?: number;
  limit?: number;
  status?: string;
  counterpartyId?: string;
  workOrderId?: string;
  q?: string;
  showDeleted?: boolean;
}

export interface PaginatedInvoices {
  items: Invoice[];
  total: number;
  page: number;
  limit: number;
}

export const invoicesKeys = {
  all: ['invoices'] as const,
  lists: () => [...invoicesKeys.all, 'list'] as const,
  list: (filters: InvoicesFilter) => [...invoicesKeys.lists(), filters] as const,
  detail: (id: string) => [...invoicesKeys.all, 'detail', id] as const,
};

export function useInvoices(filters: InvoicesFilter = {}) {
  const { employee } = useAuth();
  const params = new URLSearchParams();
  if (filters.page) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));
  if (filters.status) params.set('status', filters.status);
  if (filters.counterpartyId) params.set('counterpartyId', filters.counterpartyId);
  if (filters.workOrderId) params.set('workOrderId', filters.workOrderId);
  if (filters.q) params.set('q', filters.q);
  if (filters.showDeleted) params.set('showDeleted', 'true');
  const qs = params.toString();

  return useQuery<PaginatedInvoices>({
    queryKey: invoicesKeys.list(filters),
    queryFn: ({ signal }) => apiFetch(`/invoices${qs ? `?${qs}` : ''}`, { signal }),
    enabled: !!employee,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useInvoiceTransition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiFetch(`/invoices/${id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: invoicesKeys.all }),
  });
}

export function useDeleteInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/invoices/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: invoicesKeys.all }),
  });
}

export function useCreatePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/payments', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: invoicesKeys.all });
      qc.invalidateQueries({ queryKey: ['work-orders'] });
      // Bug #245: payments.service викликає settlements.createTransaction(PAYMENT)
      // який змінює settlementAccount.balance для counterparty. CRM-лист показує
      // currentBalance — без цієї invalidation баланс залишається стале до staleTime=30s.
      qc.invalidateQueries({ queryKey: counterpartiesKeys.all });
    },
  });
}
