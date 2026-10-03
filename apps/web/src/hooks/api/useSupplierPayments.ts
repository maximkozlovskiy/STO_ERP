import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import type { ApiSchema } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { usePaginatedList, type PaginatedResponse } from './usePaginatedList';
import { counterpartiesKeys } from './useCounterparties';
import { purchaseOrdersKeys } from './usePurchaseOrders';

/**
 * Оплата постачальнику — ЗГЕНЕРОВАНИЙ тип із OpenAPI (`pnpm run gen:api-types`).
 * Патерн — docs/PATTERNS.md, «Типи API: беремо згенероване, не пишемо своє».
 * Копія мала `status: string` замість union 'DRAFT' | 'CONFIRMED' | 'CANCELLED'.
 */
export type SupplierPayment = ApiSchema<'SupplierPaymentResponseDto'>;
export type SupplierPaymentStatusValue = SupplierPayment['status'];

/** Джерело коштів — теж зі згенерованого, щоб не розходилось із DTO. */
export type PaymentSourceType = SupplierPayment['sourceType'];

export interface SupplierPaymentsFilter extends Record<string, unknown> {
  page?: number;
  limit?: number;
  status?: string;
  supplierId?: string;
  purchaseOrderId?: string;
  q?: string;
  showDeleted?: boolean;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

export interface CreateSupplierPaymentInput {
  supplierId: string;
  sourceType: PaymentSourceType;
  bankAccountId?: string;
  cashRegisterId?: string;
  purchaseOrderId?: string;
  amount: number;
  method: string;
  notes?: string;
  documentDate?: string;
}

/** @deprecated Use PaginatedResponse<SupplierPayment> from usePaginatedList */
export type PaginatedSupplierPayments = PaginatedResponse<SupplierPayment>;

export const supplierPaymentsKeys = {
  all: ['supplier-payments'] as const,
  lists: () => [...supplierPaymentsKeys.all, 'list'] as const,
  list: (filters: SupplierPaymentsFilter) => [...supplierPaymentsKeys.lists(), filters] as const,
  detail: (id: string) => [...supplierPaymentsKeys.all, 'detail', id] as const,
  schedule: (from: string, to: string) =>
    [...supplierPaymentsKeys.all, 'schedule', from, to] as const,
  scheduleDocuments: (from: string, to: string, targetKey: string, supplierId?: string) =>
    [
      ...supplierPaymentsKeys.all,
      'schedule-docs',
      from,
      to,
      targetKey,
      supplierId ?? 'all',
    ] as const,
};

/** Шахматка боргів постачальникам — зі згенерованого (SupplierPaymentScheduleDto). */
export type SupplierPaymentSchedule = ApiSchema<'SupplierPaymentScheduleDto'>;
export type SupplierPaymentScheduleRow = ApiSchema<'SupplierPaymentScheduleRowDto'>;

/** Графік оплат — шахматка боргів постачальникам по датах (custom, non-CRUD). */
export function useSupplierPaymentsSchedule(from: string, to: string) {
  const { employee } = useAuth();
  return useQuery({
    queryKey: supplierPaymentsKeys.schedule(from, to),
    queryFn: ({ signal }) =>
      apiFetch<SupplierPaymentSchedule>(`/supplier-payments/schedule?from=${from}&to=${to}`, {
        signal,
      }),
    enabled: !!employee && !!from && !!to,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/** Документ (PO) у клітинці графіка оплат — зі згенерованого. */
export type SupplierPaymentScheduleDocument = ApiSchema<'SupplierPaymentScheduleDocumentDto'>;

/** Параметри drill-down: date XOR target (взаємовиключні), supplierId опційний. */
export type SupplierPaymentDocumentsParams =
  | { from: string; to: string; date: string; supplierId?: string }
  | { from: string; to: string; target: 'overdue' | 'planned'; supplierId?: string };

/**
 * Документи (PO) для клітинки/бакета шахматки. `params === null` поки клітинку не клікнуто
 * (enabled:false → запит не шлеться). Σ allocated == сума клітинки (спільний backend-helper).
 */
export function useSupplierPaymentDocuments(params: SupplierPaymentDocumentsParams | null) {
  const { employee } = useAuth();
  const targetKey = params ? ('date' in params ? params.date : params.target) : '';
  return useQuery({
    queryKey: params
      ? supplierPaymentsKeys.scheduleDocuments(params.from, params.to, targetKey, params.supplierId)
      : [...supplierPaymentsKeys.all, 'schedule-docs', 'disabled'],
    queryFn: ({ signal }) => {
      const p = params!;
      const qs = new URLSearchParams({ from: p.from, to: p.to });
      if (p.supplierId) qs.set('supplierId', p.supplierId);
      if ('date' in p) qs.set('date', p.date);
      else qs.set('target', p.target);
      return apiFetch<SupplierPaymentScheduleDocument[]>(
        `/supplier-payments/schedule/documents?${qs.toString()}`,
        { signal },
      );
    },
    enabled: !!employee && !!params,
    staleTime: 30_000,
  });
}

export function useSupplierPayments(filters: SupplierPaymentsFilter = {}) {
  return usePaginatedList<SupplierPayment>('/supplier-payments', filters, {
    queryKey: 'supplier-payments',
  });
}

export function useSupplierPayment(id: string | null) {
  return useQuery({
    queryKey: id ? supplierPaymentsKeys.detail(id) : ['supplier-payments', 'detail', null],
    queryFn: () => apiFetch<SupplierPayment>(`/supplier-payments/${id}`),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useCreateSupplierPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateSupplierPaymentInput) =>
      apiFetch<SupplierPayment>('/supplier-payments', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: supplierPaymentsKeys.all });
      // Створення оплати (навіть DRAFT) впливає на залишок боргу по PO
      // (outstanding у списку PurchaseOrders) — інвалідуємо, інакше PO-список
      // показує застарілий outstanding до staleTime.
      void qc.invalidateQueries({ queryKey: purchaseOrdersKeys.all });
    },
  });
}

export function useUpdateSupplierPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<CreateSupplierPaymentInput> }) =>
      apiFetch<SupplierPayment>(`/supplier-payments/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    onSuccess: (_, { id }) => {
      void qc.invalidateQueries({ queryKey: supplierPaymentsKeys.all });
      void qc.invalidateQueries({ queryKey: supplierPaymentsKeys.detail(id) });
    },
  });
}

export function useConfirmSupplierPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<SupplierPayment>(`/supplier-payments/${id}/confirm`, { method: 'POST' }),
    onSuccess: (_, id) => {
      void qc.invalidateQueries({ queryKey: supplierPaymentsKeys.all });
      void qc.invalidateQueries({ queryKey: supplierPaymentsKeys.detail(id) });
      // Bug #590: confirm() пише settlement PAYMENT → зменшує баланс постачальника
      // у settlementAccount.balance. CRM/counterparties list, PurchaseOrder деталь
      // та баланси у dossier показують застарілий баланс до staleTime=30s без
      // цього invalidate. Дзеркалить useCreatePayment (Bug #245).
      void qc.invalidateQueries({ queryKey: counterpartiesKeys.all });
      // confirm() зменшує залишок боргу по PO (outstanding у списку) — без цього
      // PO-список показує застарілий outstanding до staleTime.
      void qc.invalidateQueries({ queryKey: purchaseOrdersKeys.all });
    },
  });
}

export function useCancelSupplierPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<SupplierPayment>(`/supplier-payments/${id}/cancel`, { method: 'POST' }),
    onSuccess: (_, id) => {
      void qc.invalidateQueries({ queryKey: supplierPaymentsKeys.all });
      void qc.invalidateQueries({ queryKey: supplierPaymentsKeys.detail(id) });
      // cancel() з DRAFT НЕ пише settlement (guard у service), тож counterparties
      // балансу не чіпає. Явно НЕ інвалідовано щоб уникнути зайвих refetch на CRM.
    },
  });
}

export function useDeleteSupplierPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/supplier-payments/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: supplierPaymentsKeys.all });
    },
  });
}
