import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiSchema } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { usePaginatedList, type PaginatedResponse } from './usePaginatedList';
import { invalidatePaymentSideEffects } from '@/lib/cache-invalidation';

/**
 * Рахунок — ЗГЕНЕРОВАНИЙ тип із OpenAPI (Крок 4 аудиту, `pnpm run gen:api-types`).
 *
 * Раніше тут був рукописний `interface Invoice` — одна з п'яти копій
 * `InvoiceResponseDto` (ще: `InvoiceWithOptionals`/`InvoiceLine` у invoices/page.tsx,
 * `InvoiceDetail`/`InvoiceLine` у InvoiceCreateModal). Копія була СЛАБША за оригінал
 * і місцями просто неправильна:
 *   · `status: string` замість union 'DRAFT' | 'SENT' | ... | 'CANCELLED'
 *     → `inv.status === 'PAYED'` (опечатка) компілювався б без помилки;
 *   · `totalWithoutVat/totalVat/totalWithVat?: number | null` — у беку це
 *     ОБОВ'ЯЗКОВІ `number` (@ApiProperty + Number() у toDto), тож web марно
 *     ганяв `?? 0`-фолбеки по всьому UI;
 *   · `orgId?` опційний, хотя бек віддає його завжди;
 *   · бракувало `unitOfMeasureId` і `lines` — рядки описувались окремим типом.
 *
 * Патерн міграції решти хуків — docs/PATTERNS.md, «Типи API: беремо згенероване».
 */
export type Invoice = ApiSchema<'InvoiceResponseDto'>;

/** Рядок рахунку (`lines` у InvoiceResponseDto) — теж зі згенерованого. */
export type InvoiceLine = ApiSchema<'InvoiceLineResponseDto'>;

/** Статус рахунку як union — для exhaustive switch/map у UI. */
export type InvoiceStatusValue = Invoice['status'];

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
