import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import type { ApiSchema } from '@sto/shared';
import { apiFetch, apiPost } from '@/lib/api-client';
import { usePaginatedList } from './usePaginatedList';
import { useAuth } from '@/lib/auth';
import { counterpartiesKeys } from './useCounterparties';
import { purchaseOrdersKeys } from './usePurchaseOrders';

/**
 * Оплата постачальнику — ЗГЕНЕРОВАНИЙ тип із OpenAPI (`pnpm run gen:api-types`).
 * Патерн — docs/PATTERNS.md, «Типи API: беремо згенероване, не пишемо своє».
 * Копія мала `status: string` замість union 'DRAFT' | 'CONFIRMED' | 'CANCELLED'.
 */
export type SupplierPayment = ApiSchema<'SupplierPaymentResponseDto'>;

/** Джерело коштів — теж зі згенерованого, щоб не розходилось із DTO. */
export type PaymentSourceType = SupplierPayment['sourceType'];

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

export const supplierPaymentsKeys = {
  all: ['supplier-payments'] as const,
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

/**
 * Після проведення оплати (однією дією чи «Провести» чернетки) змінюються: перелік і графік оплат,
 * баланс постачальника (Bug #590 — CRM, дос'є) і «сплачено» / залишок замовлення (список PO).
 */
function invalidateAfterPayment(qc: ReturnType<typeof useQueryClient>, id?: string) {
  void qc.invalidateQueries({ queryKey: supplierPaymentsKeys.all });
  if (id) void qc.invalidateQueries({ queryKey: supplierPaymentsKeys.detail(id) });
  void qc.invalidateQueries({ queryKey: counterpartiesKeys.all });
  void qc.invalidateQueries({ queryKey: purchaseOrdersKeys.all });
}

/**
 * Оплатити постачальнику: створити й провести ОДНІЄЮ дією (BR-SUPPAY-013). `idempotencyKey` — один
 * на відкриття вікна оплати: повтор після обриву відповіді віддає ту саму оплату, а не проводить
 * другу. Відмова (каса в мінус, зміна закрита, замовлення не того статусу) не лишає документа.
 */
export function usePaySupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      data,
      idempotencyKey,
    }: {
      data: CreateSupplierPaymentInput;
      idempotencyKey: string;
    }) =>
      apiPost<SupplierPayment>('/supplier-payments/pay', data, {
        'Idempotency-Key': idempotencyKey,
      }),
    onSuccess: res => invalidateAfterPayment(qc, res.id),
  });
}

/**
 * «Провести» чернетку (BR-SUPPAY-014). Маршрут вимагає `Idempotency-Key` — один на дію рядка: повтор
 * після обриву віддає збережену відповідь, а не 400 «вже проведено».
 */
export function useConfirmSupplierPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, idempotencyKey }: { id: string; idempotencyKey: string }) =>
      apiPost<SupplierPayment>(`/supplier-payments/${id}/confirm`, undefined, {
        'Idempotency-Key': idempotencyKey,
      }),
    onSuccess: (_, { id }) => invalidateAfterPayment(qc, id),
  });
}

/** Фільтри переліку оплат постачальнику (вкладка «Оплати постачальникам»). */
export interface SupplierPaymentsListFilters extends Record<string, unknown> {
  status: string;
  page: number;
  limit: number;
}

/** Перелік оплат постачальнику з фільтром статусу (BR-SUPPAY-014: «Чернетки» — старі невидимі чернетки). */
export function useSupplierPaymentsList(filters: SupplierPaymentsListFilters) {
  return usePaginatedList<SupplierPayment>('/supplier-payments', filters, {
    queryKey: supplierPaymentsKeys.all[0],
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
