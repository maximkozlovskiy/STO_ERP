import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';

export interface PayrollLine {
  employeeId: string;
  employeeName: string;
  rateSchemeType: string;
  baseAmount: number;
  normoHours: number;
  linesCount: number;
  accruedAmount: number;
  paidAmount?: number;
}

export interface PayrollPreview {
  lines: PayrollLine[];
  totalAccrued: number;
  from: string;
  to: string;
}

export interface PayrollPeriod {
  id: string;
  orgId: string;
  branchId?: string | null;
  periodStart: string;
  periodEnd: string;
  status: 'DRAFT' | 'COMPUTED' | 'PAID' | 'CANCELLED';
  note?: string | null;
  totalAccrued: number;
  totalPaid: number;
  lines?: PayrollLine[];
  computedAt?: string | null;
  paidAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export const payrollKeys = {
  all: ['payroll'] as const,
  preview: (from: string, to: string, branchId?: string) =>
    [...payrollKeys.all, 'preview', from, to, branchId ?? ''] as const,
  periods: () => [...payrollKeys.all, 'periods'] as const,
  period: (id: string) => [...payrollKeys.all, 'period', id] as const,
};

/** Preview розрахунку — enabled лише коли є дати (кнопка «Розрахувати»). */
export function usePayrollPreview(from: string, to: string, branchId: string, enabled: boolean) {
  return useQuery({
    queryKey: payrollKeys.preview(from, to, branchId),
    queryFn: () => {
      const params = new URLSearchParams({ from, to });
      if (branchId) params.set('branchId', branchId);
      return apiFetch<PayrollPreview>(`/payroll/preview?${params.toString()}`);
    },
    enabled,
  });
}

export function usePayrollPeriods() {
  return useQuery({
    queryKey: payrollKeys.periods(),
    queryFn: () => apiFetch<PayrollPeriod[]>('/payroll/periods'),
  });
}

export function usePayrollPeriod(id: string | null) {
  return useQuery({
    queryKey: payrollKeys.period(id ?? ''),
    queryFn: () => apiFetch<PayrollPeriod>(`/payroll/periods/${id}`),
    enabled: !!id,
  });
}

export function useCreatePayrollPeriod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      periodStart: string;
      periodEnd: string;
      branchId?: string;
      note?: string;
    }) =>
      apiFetch<PayrollPeriod>('/payroll/periods', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: payrollKeys.periods() }),
  });
}

export function useComputePayrollPeriod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<PayrollPeriod>(`/payroll/periods/${id}/compute`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: payrollKeys.all }),
  });
}

export function usePayPayrollPeriod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, cashRegisterId }: { id: string; cashRegisterId?: string }) =>
      apiFetch<PayrollPeriod>(`/payroll/periods/${id}/pay`, {
        method: 'POST',
        body: JSON.stringify(cashRegisterId ? { cashRegisterId } : {}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: payrollKeys.all }),
  });
}

export function useDeletePayrollPeriod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/payroll/periods/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: payrollKeys.periods() }),
  });
}

export const PAYROLL_STATUS_LABELS: Record<PayrollPeriod['status'], string> = {
  DRAFT: 'Чернетка',
  COMPUTED: 'Розраховано',
  PAID: 'Виплачено',
  CANCELLED: 'Скасовано',
};

export const RATE_SCHEME_LABELS: Record<string, string> = {
  percent_normo: '% від суми робіт',
  per_normo_hour: 'Ставка × нормо-год',
  fixed_plus_bonus: 'Ставка + бонус',
  unknown: 'Не вказано',
};
