import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface CashRegister {
  id: string;
  orgId: string;
  name: string;
  currencyId: string;
  currencyCode: string;
  currencySymbol?: string | null;
  branchId: string;
  branchName: string;
  isFiscal: boolean;
  initialBalance: number;
  balance: number;
  createdAt: string;
  updatedAt: string;
}

export interface CashOperation {
  id: string;
  cashRegisterId: string;
  cashShiftId?: string | null;
  direction: 'IN' | 'OUT';
  amount: number;
  reason: string;
  expenseCategoryId?: string | null;
  expenseCategoryName?: string | null;
  counterpartyId?: string | null;
  employeeId?: string | null;
  documentType?: string | null;
  documentId?: string | null;
  notes?: string | null;
  createdAt: string;
}

export interface CreateCashOperationBody {
  direction: 'IN' | 'OUT';
  amount: number;
  reason: string;
  expenseCategoryId?: string;
  counterpartyId?: string;
  notes?: string;
}

export const cashKeys = {
  all: ['cash'] as const,
  registers: () => [...cashKeys.all, 'registers'] as const,
  operations: (id: string) => [...cashKeys.all, 'operations', id] as const,
};

export const CASH_REASON_LABELS: Record<string, string> = {
  SALE_PAYMENT: 'Оплата клієнта',
  REFUND: 'Повернення клієнту',
  PAYROLL: 'Виплата ЗП',
  SUPPLIER_PAYMENT: 'Оплата постачальнику',
  EXPENSE: 'Витрата',
  COLLECTION: 'Інкасація',
  MANUAL_IN: 'Внесення',
  MANUAL_OUT: 'Видача',
};

/** Приводи, доступні для ручного внесення (IN). */
export const MANUAL_IN_REASONS = ['MANUAL_IN', 'COLLECTION'] as const;
/** Приводи, доступні для ручної видачі (OUT). */
export const MANUAL_OUT_REASONS = ['MANUAL_OUT', 'EXPENSE', 'SUPPLIER_PAYMENT', 'REFUND'] as const;

export function useCashRegisters() {
  return useQuery({
    queryKey: cashKeys.registers(),
    queryFn: () =>
      apiFetch<{ items: CashRegister[]; total: number }>('/cash-registers').then(r => r.items),
  });
}

export function useCashOperations(cashRegisterId: string | null) {
  return useQuery({
    queryKey: cashKeys.operations(cashRegisterId ?? ''),
    queryFn: () => apiFetch<CashOperation[]>(`/cash-registers/${cashRegisterId}/operations`),
    enabled: !!cashRegisterId,
  });
}

export function useCreateCashRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      branchId: string;
      currencyId: string;
      isFiscal?: boolean;
      initialBalance?: number;
    }) => apiFetch<CashRegister>('/cash-registers', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: cashKeys.registers() }),
  });
}

export function useUpdateCashRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      name?: string;
      isFiscal?: boolean;
      initialBalance?: number;
    }) =>
      apiFetch<CashRegister>(`/cash-registers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: cashKeys.registers() }),
  });
}

export function useDeleteCashRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/cash-registers/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: cashKeys.registers() }),
  });
}

export function useCreateCashOperation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      cashRegisterId,
      ...body
    }: { cashRegisterId: string } & CreateCashOperationBody) =>
      apiFetch<CashOperation>(`/cash-registers/${cashRegisterId}/operations`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: cashKeys.all }),
  });
}
