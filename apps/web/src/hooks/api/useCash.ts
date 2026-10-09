import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { operations } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { buildParams } from './usePaginatedList';

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
  /** Код ПРРО-провайдера цієї каси (checkbox|vchasno) або null. */
  fiscalProvider?: string | null;
  /** ID каси на боці провайдера (Checkbox cashRegisterId). */
  providerCashRegisterId?: string | null;
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
  /** Сума у базовій валюті (UAH) по курсу на дату операції (мультивалюта Фаза 1). */
  amountBase?: number | null;
  /** Застосований курс (base за 1 од. валюти каси). */
  rateUsed?: number | null;
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

export type CashOperationsFilter = Pick<
  NonNullable<operations['CashRegistersController_operations_v1']['parameters']['query']>,
  'q' | 'dateFrom' | 'dateTo'
>;

export const cashKeys = {
  all: ['cash'] as const,
  registers: () => [...cashKeys.all, 'registers'] as const,
  operations: (id: string, filters: CashOperationsFilter) =>
    [...cashKeys.all, 'operations', id, filters] as const,
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

/**
 * Базова валюта org (OrganisationSettings.currency) — код + символ.
 * amountBase зберігається у базовій валюті org; каса вважається базовою, коли її код === базовому.
 * НЕ хардкодити 'UAH'/'₴' в UI: база конфігурована (rule Configuration over Hardcode), org може мати
 * іншу базу — тоді і колонка «У базовій», і її символ мають слідувати за реальною базою.
 */
export interface BaseCurrency {
  code: string;
  symbol: string;
}
export function useBaseCurrency() {
  return useQuery({
    queryKey: ['settings', 'base-currency'],
    queryFn: async (): Promise<BaseCurrency> => {
      const [settings, currencies] = await Promise.all([
        apiFetch<{ currency: string }>('/settings/organisation'),
        apiFetch<{ items: { code: string; symbol?: string | null }[]; total: number }>(
          '/currencies',
        ).catch(() => ({ items: [], total: 0 })),
      ]);
      const code = settings.currency || 'UAH';
      const match = currencies.items?.find(c => c.code === code);
      // Fallback-символ для базового UAH коли /currencies недоступний.
      const symbol = match?.symbol || (code === 'UAH' ? '₴' : code);
      return { code, symbol };
    },
    staleTime: 30 * 60 * 1000,
  });
}

export function useCashRegisters() {
  return useQuery({
    queryKey: cashKeys.registers(),
    queryFn: () =>
      apiFetch<{ items: CashRegister[]; total: number }>('/cash-registers').then(r => r.items),
    // Довідник кас — рідко міняється під час сесії. Без staleTime (дефолт 0) кожен
    // перемик табу (CashOperationsTab/CashRegistersTab) і візит payroll re-fetch-ив
    // список. Усі мутації (create/update/delete) invalidate-ять registers() → safe.
    staleTime: 5 * 60_000,
  });
}

export function useCashOperations(cashRegisterId: string | null, filters: CashOperationsFilter) {
  const qs = buildParams(filters);

  return useQuery({
    queryKey: cashKeys.operations(cashRegisterId ?? '', filters),
    queryFn: ({ signal }) =>
      apiFetch<CashOperation[]>(`/cash-registers/${cashRegisterId}/operations${qs}`, { signal }),
    enabled: !!cashRegisterId,
    // Зміна пошуку чи дати — це новий ключ: без цього таблиця на мить порожніла б.
    // Лише в межах тієї самої каси: рядки попередньої каси під назвою нової — неправда.
    placeholderData: (prev, prevQuery) =>
      cashRegisterId && prevQuery?.queryKey.includes(cashRegisterId) ? prev : undefined,
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
      fiscalProvider?: string;
      providerCashRegisterId?: string;
      initialBalance?: number;
    }) => apiFetch<CashRegister>('/cash-registers', { method: 'POST', body: JSON.stringify(body) }),
    // NOTE: create приймає лише "задано або ні" (без null) — порожні '' конвертуються у null лише
    // на update-стороні бекенду (empty-to-null), де є "існуюче" значення яке можна очистити.
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
      currencyId?: string;
      isFiscal?: boolean;
      /** '' очищає прив'язку (бекенд: empty-to-null). */
      fiscalProvider?: string;
      /** '' очищає значення (бекенд: empty-to-null). */
      providerCashRegisterId?: string;
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
