import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { usePaginatedList, type PaginatedResponse } from './usePaginatedList';
import { invalidatePaymentSideEffects } from '@/lib/cache-invalidation';

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
  documentDate?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface InvoicesFilter extends Record<string, unknown> {
  page?: number;
  limit?: number;
  status?: string;
  counterpartyId?: string;
  workOrderId?: string;
  q?: string;
  showDeleted?: boolean;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

/** @deprecated Use PaginatedResponse<Invoice> from usePaginatedList */
export type PaginatedInvoices = PaginatedResponse<Invoice>;

export const invoicesKeys = {
  all: ['invoices'] as const,
  lists: () => [...invoicesKeys.all, 'list'] as const,
  list: (filters: InvoicesFilter) => [...invoicesKeys.lists(), filters] as const,
  detail: (id: string) => [...invoicesKeys.all, 'detail', id] as const,
};

export function useInvoices(filters: InvoicesFilter = {}) {
  return usePaginatedList<Invoice>('/invoices', filters, {
    queryKey: 'invoices',
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
    // WEB-R3-2: спільний хелпер — інвалідує invoices+work-orders+payments+баланс(counterparties/
    // reports/dashboard). Раніше пропускав payments-list (список платежів лишався стале).
    onSuccess: () => invalidatePaymentSideEffects(qc),
  });
}
