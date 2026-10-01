import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { usePaginatedList, type PaginatedResponse } from './usePaginatedList';

/**
 * Розшифровка нарахування по одному наряду — дзеркалить PayrollLineWorkOrderDto.
 * baseAmount = Σ сума робіт наряду (частка бази); нарахування рахується від СУМИ бази за схемою,
 * тому по-нарядно не розкидається.
 */
export interface PayrollLineWorkOrder {
  workOrderId: string;
  workOrderNumber: string;
  vehicleName?: string | null;
  worksCount: number;
  normoHours: number;
  baseAmount: number;
}

export interface PayrollLine {
  employeeId: string;
  employeeName: string;
  rateSchemeType: string;
  baseAmount: number;
  normoHours: number;
  linesCount: number;
  accruedAmount: number;
  paidAmount?: number;
  /** Розшифровка по нарядах — приходить лише з GET /payroll/periods/:id (не зі списку). */
  workOrders?: PayrollLineWorkOrder[];
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

/** Фільтри списку періодів — дзеркалить PayrollPeriodListQueryDto (page/limit/status). */
export interface PayrollPeriodsFilter extends Record<string, unknown> {
  page?: number;
  limit?: number;
  status?: string;
}

export type PaginatedPayrollPeriods = PaginatedResponse<PayrollPeriod>;

export const payrollKeys = {
  all: ['payroll'] as const,
  preview: (from: string, to: string, branchId?: string) =>
    [...payrollKeys.all, 'preview', from, to, branchId ?? ''] as const,
  // Матчить usePaginatedList queryKey = [queryKey, 'list', filters] (див. usePaginatedList).
  periodsLists: () => ['payroll-periods', 'list'] as const,
  periods: (filters: PayrollPeriodsFilter = {}) =>
    [...payrollKeys.periodsLists(), filters] as const,
  period: (id: string) => [...payrollKeys.all, 'period', id] as const,
};

/**
 * Інвалідація ВСЬОГО payroll-кешу. Список періодів живе під окремим префіксом
 * `['payroll-periods','list',…]` (контракт usePaginatedList), тому `payrollKeys.all` сам його
 * НЕ покриває — після compute/pay треба збивати обидва дерева, інакше статус у списку лишається
 * старим до перезавантаження сторінки.
 */
function invalidateAllPayroll(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: payrollKeys.all });
  void qc.invalidateQueries({ queryKey: payrollKeys.periodsLists() });
}

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

/**
 * Сторінка зарплатних періодів. Список НЕ несе розшифровки по нарядах — її тягне
 * usePayrollPeriod(id) при розкритті (drill-down).
 */
export function usePayrollPeriods(filters: PayrollPeriodsFilter = {}) {
  return usePaginatedList<PayrollPeriod>('/payroll/periods', filters, {
    queryKey: 'payroll-periods',
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
    onSuccess: () => qc.invalidateQueries({ queryKey: payrollKeys.periodsLists() }),
  });
}

export function useComputePayrollPeriod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<PayrollPeriod>(`/payroll/periods/${id}/compute`, { method: 'POST' }),
    onSuccess: () => invalidateAllPayroll(qc),
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
    onSuccess: () => invalidateAllPayroll(qc),
  });
}

export function useDeletePayrollPeriod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/payroll/periods/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: payrollKeys.periodsLists() }),
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
