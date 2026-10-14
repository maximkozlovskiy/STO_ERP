import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiSchema, operations, CashOperationFormValues } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import {
  invalidatePaymentSideEffects,
  invalidatePurchaseSideEffects,
} from '@/lib/cache-invalidation';
import { buildParams } from './usePaginatedList';

/**
 * Каса й рядок історії — ЗГЕНЕРОВАНІ типи із OpenAPI (`pnpm run gen:api-types`); поля звірені
 * з реальною відповіддю dev-API. Патерн — docs/PATTERNS.md, «Типи API: беремо згенероване».
 */
export type CashRegister = ApiSchema<'CashRegisterResponseDto'>;
export type CashOperation = ApiSchema<'CashOperationResponseDto'>;

/** Тіло POST /cash-registers/:id/operations — рівно вихід спільної `cashOperationSchema`. */
export type CreateCashOperationBody = CashOperationFormValues;

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

// Підписи приводів живуть в одному місці — каталозі `cash:reasons.*` (uk + en); перелік
// приводів і правила полів — у `CASH_REASON_RULES` / `manualCashReasons` з `@sto/shared`.

/**
 * Базова валюта org (OrganisationSettings.currency) — код + символ.
 * amountBase зберігається у базовій валюті org; каса вважається базовою, коли її код === базовому.
 * НЕ хардкодити 'UAH'/'₴' в UI: база конфігурована (rule Configuration over Hardcode), org може мати
 * іншу базу — тоді і колонка «У базовій», і її символ мають слідувати за реальною базою.
 *
 * Код бере з GET /settings/base-currency (усі ролі), а НЕ з /settings/organisation: повні
 * налаштування читають лише власник і адміністратор, тож бухгалтер і приймальня на кожному
 * екрані з грошима отримували 403 і лишались без базової валюти (Bug #847).
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
        apiFetch<{ currency: string }>('/settings/base-currency'),
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

/**
 * `limit` — скільки найновіших рядків просити. Без нього сервер віддає 100 (BR-CASH-015), і
 * таблиця мовчки обрізала день зі 105 операціями (Bug #849); у ключ кешу він не входить, бо
 * екран завжди просить те саме число.
 */
export function useCashOperations(
  cashRegisterId: string | null,
  filters: CashOperationsFilter,
  limit?: number,
) {
  const qs = buildParams({ ...filters, limit });

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

/**
 * Ручна касова операція. `idempotencyKey` — один на відкриття картки: повтор запиту після
 * обриву на відповіді не створює другої оплати.
 *
 * Операція з контрагентом рухає не лише касу: оплата контрагента закриває рахунок і наряд,
 * оплата постачальнику — замовлення, обидві міняють борг. Тому після успіху скидаємо й кеші
 * оплат та закупівель, а не лише касу.
 */
export function useCreateCashOperation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      cashRegisterId,
      idempotencyKey,
      ...body
    }: { cashRegisterId: string; idempotencyKey?: string } & CreateCashOperationBody) =>
      apiFetch<CashOperation>(`/cash-registers/${cashRegisterId}/operations`, {
        method: 'POST',
        ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: cashKeys.all });
      invalidatePaymentSideEffects(qc);
      invalidatePurchaseSideEffects(qc);
    },
    // Відмова не доводить, що нічого не сталось: відповідь могла не дійти, а операція — пройти.
    // Історія й залишок за карткою мають показати правду ще до того, як картку закриють.
    onError: () => {
      void qc.invalidateQueries({ queryKey: cashKeys.all });
    },
  });
}

/** Повтор фіскального чека оплати з рядка каси (POST /payments/:id/retry-fiscal). */
export function useRetryCashFiscal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paymentId: string) =>
      apiFetch<unknown>(`/payments/${paymentId}/retry-fiscal`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: cashKeys.all });
      invalidatePaymentSideEffects(qc);
    },
  });
}
