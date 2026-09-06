import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { usePaginatedList, type PaginatedResponse } from './usePaginatedList';
import { counterpartiesKeys } from './useCounterparties';

export type PaymentSourceType = 'BANK_ACCOUNT' | 'CASH_REGISTER';

/** Клієнтський платіж — дзеркалить PaymentResponseDto. Append-only (без edit/delete на UI). */
export interface Payment {
  id: string;
  orgId?: string;
  counterpartyId: string;
  counterpartyName?: string;
  workOrderId: string | null;
  invoiceId: string | null;
  amount: number;
  method: string;
  notes: string | null;
  fiscalReceiptId: string | null;
  fiscalStatus: string | null; // QUEUED/DONE/FAILED/SKIPPED або null (не застосовно)
  fiscalError: string | null;
  sourceType: PaymentSourceType | null;
  bankAccountId: string | null;
  cashRegisterId: string | null;
  sourceName: string | null; // назва каси/банку для UI
  createdAt: string;
}

export interface PaymentsFilter extends Record<string, unknown> {
  page?: number;
  limit?: number;
  counterpartyId?: string;
  dateFrom?: string;
  dateTo?: string;
  method?: string;
  fiscalStatus?: string; // enum-значення або 'none' (без фіскалізації)
}

/** @deprecated Use PaginatedResponse<Payment> */
export type PaginatedPayments = PaginatedResponse<Payment>;

export const paymentsKeys = {
  all: ['payments'] as const,
  lists: () => [...paymentsKeys.all, 'list'] as const,
  list: (filters: PaymentsFilter) => [...paymentsKeys.lists(), filters] as const,
  detail: (id: string) => [...paymentsKeys.all, 'detail', id] as const,
};

export function usePayments(filters: PaymentsFilter = {}) {
  return usePaginatedList<Payment>('/payments', filters, { queryKey: 'payments' });
}

export function usePayment(id: string | null) {
  return useQuery({
    queryKey: id ? paymentsKeys.detail(id) : ['payments', 'detail', null],
    queryFn: () => apiFetch<Payment>(`/payments/${id}`),
    enabled: !!id,
    staleTime: 30_000,
  });
}

/** Повторна фіскалізація невдалого чеку (FAILED → QUEUED + re-enqueue). */
export function useRetryFiscal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<Payment>(`/payments/${id}/retry-fiscal`, { method: 'POST' }),
    onSuccess: (_, id) => {
      void qc.invalidateQueries({ queryKey: paymentsKeys.all });
      void qc.invalidateQueries({ queryKey: paymentsKeys.detail(id) });
      void qc.invalidateQueries({ queryKey: counterpartiesKeys.all });
    },
  });
}
