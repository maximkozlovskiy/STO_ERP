import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiSchema, operations } from '@sto/shared';
import { apiFetch, apiMultipartFetch } from '@/lib/api-client';
import { usePaginatedList, type PaginatedResponse } from './usePaginatedList';
import { supplierPaymentsKeys } from './useSupplierPayments';
import { cashKeys } from './useCash';

/**
 * Банк-транзакція (виписка) — ЗГЕНЕРОВАНИЙ тип із OpenAPI.
 * Патерн — docs/PATTERNS.md, «Типи API: беремо згенероване, не пишемо своє».
 *
 * Раніше інтерфейс писався руками і мав `direction/source/status/matchedType`
 * як `string` — попри те, що поруч у цьому ж файлі вже лежали правильні union-и
 * BankTxStatus/BankTxMatchType. У DTO беку теж був `string` (виправлено разом).
 */
export type BankTransaction = ApiSchema<'BankTransactionResponseDto'>;

/** Тип рознесення банк-транзакції (BankTransactionMatchType). */
export type BankTxMatchType = NonNullable<BankTransaction['matchedType']>;

/** Статус staging-транзакції (BankTransactionStatus). */
export type BankTxStatus = BankTransaction['status'];

/** Один рядок прев'ю імпорту з результатом авто-матчу — зі згенерованого. */
export type PreviewRow = ApiSchema<'PreviewRowDto'>;

/** Причина авто-матчу рядка прев'ю. */
export type PreviewMatchStatus = PreviewRow['matchStatus'];

/** Ознака, за якою знайдено збіг. */
export type PreviewMatchReason = NonNullable<PreviewRow['matchReason']>;

/** Кандидат-контрагент для ambiguous-рядка — зі згенерованого. */
export type PreviewCandidate = ApiSchema<'PreviewCandidateDto'>;

/**
 * Мапінг колонок файлу виписки (1-based) — рукописний НАВМИСНО.
 * `/import/preview` приймає multipart, і контролер розбирає ці поля вручну
 * (`buildMapping`), тож `PreviewImportColumnMapping` у Swagger-документі не
 * з'являється взагалі — генерувати нема з чого. Єдиний виняток у цьому файлі.
 */
export interface ColumnMapping {
  startRow?: number;
  dateCol: number;
  amountCol: number;
  externalIdCol: number;
  payerNameCol?: number;
  payerIbanCol?: number;
  payerEdrpouCol?: number;
  purposeCol?: number;
  /** BR-BANK-018: SIGN (типово) — за знаком суми / колонкою списання; IN / OUT — увесь файл. */
  directionMode?: ImportDirectionMode;
  /** Колонка суми списання — лише для режиму SIGN. */
  debitCol?: number;
}

export type ImportDirectionMode = 'SIGN' | 'IN' | 'OUT';

/**
 * Сира сітка перших рядків для column-mapping — зі згенерованого.
 * Рукописна копія не мала `columnCount`, хоча бек його віддає й UI міг би
 * використати замість перерахунку максимуму довжин рядків.
 */
export type RawPreviewResult = ApiSchema<'RawPreviewResponseDto'>;

/** Рядок для apply — зі згенерованого (ApplyRowDto). */
export type ApplyRow = ApiSchema<'ApplyRowDto'>;

/** Результат apply — зі згенерованого (ApplyImportResultDto). */
export type ApplyImportResult = ApiSchema<'ApplyImportResultDto'>;

export interface MatchTransactionInput {
  counterpartyId: string;
  type: BankTxMatchType;
  invoiceId?: string;
}

/** Напрямок платежу (BankTransactionDirection) — зі згенерованого, як і решта union-ів файла. */
export type BankTxDirection = BankTransaction['direction'];

type BankTransactionsQuery = NonNullable<
  operations['BankStatementsController_list_v1']['parameters']['query']
>;

export interface BankTransactionsFilter
  extends Record<string, unknown>, Pick<BankTransactionsQuery, 'q' | 'dateFrom' | 'dateTo'> {
  status?: string;
  /** Напрямок платежу: 'IN' — вхідні, 'OUT' — вихідні; без значення — усі. */
  direction?: BankTxDirection;
  page?: number;
  limit?: number;
}

export const bankTransactionsKeys = {
  all: ['bank-transactions'] as const,
  supplierPaymentCandidates: (id: string) =>
    [...bankTransactionsKeys.all, 'supplier-payment-candidates', id] as const,
  /** Довідник рахунків для модалок платежу — окремий префікс, щоб мутації платежів його не збивали. */
  bankAccountOptions: ['bank-accounts', 'options'] as const,
};

/** Тіло ручного внесення платежу (CreateBankTransactionDto). */
export type CreateBankTransactionInput = ApiSchema<'CreateBankTransactionDto'>;
/** Тіло рознесення вихідного платежу / переказу (ReconcileTransactionDto). */
export type ReconcileTransactionInput = ApiSchema<'ReconcileTransactionDto'>;
/** Вид рознесення через `reconcile`. */
export type BankTxReconcileType = ReconcileTransactionInput['type'];
/** Тіло скасування рознесення (UnreconcileTransactionDto). */
export type UnreconcileTransactionInput = ApiSchema<'UnreconcileTransactionDto'>;
/** Проведена оплата постачальнику, до якої можна прив'язати рядок. */
export type SupplierPaymentCandidate = ApiSchema<'SupplierPaymentCandidateDto'>;
/** Банківський рахунок (довідник для вибору в модалках). */
export type BankAccountOption = ApiSchema<'BankAccountResponseDto'>;
/** Джерело рядка (BankTransactionSource). */
export type BankTxSource = BankTransaction['source'];

export type PaginatedBankTransactions = PaginatedResponse<BankTransaction>;

/** Список банк-транзакцій (виписка). Пагінація + фільтр статусу. */
export function useBankTransactions(filters: BankTransactionsFilter = {}) {
  return usePaginatedList<BankTransaction>('/bank-statements/transactions', filters, {
    queryKey: 'bank-transactions',
  });
}

/** Рознести транзакцію на контрагента (POST .../match) → створює платіж. */
export function useMatchBankTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: MatchTransactionInput }) =>
      apiFetch<BankTransaction>(`/bank-statements/transactions/${id}/match`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bankTransactionsKeys.all });
    },
  });
}

/** Позначити транзакцію нерелевантною (POST .../ignore). */
export function useIgnoreBankTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiFetch<BankTransaction>(`/bank-statements/transactions/${id}/ignore`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bankTransactionsKeys.all });
    },
  });
}

/** Банківські рахунки для вибору в модалках платежу. Завжди свіжі: рахунки правляться поруч. */
export function useBankAccountOptions(enabled = true) {
  return useQuery({
    queryKey: bankTransactionsKeys.bankAccountOptions,
    queryFn: ({ signal }) =>
      apiFetch<{ items: BankAccountOption[] }>('/bank-accounts', { signal }).then(
        r => r.items ?? [],
      ),
    enabled,
  });
}

/**
 * Внести платіж вручну (POST /bank-statements/transactions, BR-BANK-023).
 * `idempotencyKey` — один на відкриття форми: повтор запиту не створює другий рядок.
 */
export function useCreateBankTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      data,
      idempotencyKey,
    }: {
      data: CreateBankTransactionInput;
      idempotencyKey: string;
    }) =>
      apiFetch<BankTransaction>('/bank-statements/transactions', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bankTransactionsKeys.all });
    },
  });
}

/** Видалити ручний нерознесений платіж (DELETE …/:id, BR-BANK-024). */
export function useDeleteBankTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/bank-statements/transactions/${id}`, { method: 'DELETE' }),
    // onSettled: 409 «уже рознесено» теж означає, що список застарів.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: bankTransactionsKeys.all });
    },
  });
}

/** Кандидати-оплати постачальнику для прив'язки рядка (GET …/:id/supplier-payment-candidates). */
export function useSupplierPaymentCandidates(txId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: bankTransactionsKeys.supplierPaymentCandidates(txId ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<SupplierPaymentCandidate[]>(
        `/bank-statements/transactions/${txId}/supplier-payment-candidates`,
        { signal },
      ),
    enabled: enabled && !!txId,
  });
}

/**
 * Рознести платіж за видом (POST …/:id/reconcile, BR-BANK-025…034).
 * Оплата постачальнику й зняття готівки змінюють чужі списки — їх теж збиваємо.
 */
export function useReconcileBankTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: ReconcileTransactionInput }) =>
      apiFetch<BankTransaction>(`/bank-statements/transactions/${id}/reconcile`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: (_res, { data }) => {
      if (data.type === 'SUPPLIER_PAYMENT')
        void qc.invalidateQueries({ queryKey: supplierPaymentsKeys.all });
      if (data.type === 'CASH_WITHDRAWAL') void qc.invalidateQueries({ queryKey: cashKeys.all });
    },
    // onSettled, не onSuccess: відмова 409 «уже рознесено» означає, що рядок у списку застарів.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: bankTransactionsKeys.all });
    },
  });
}

/** Скасувати рознесення (POST …/:id/unreconcile, BR-BANK-039) — причина обов'язкова. */
export function useUnreconcileBankTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => {
      const data: UnreconcileTransactionInput = { reason };
      return apiFetch<BankTransaction>(`/bank-statements/transactions/${id}/unreconcile`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      // Зворотна касова операція (зняття готівки) і відв'язана оплата постачальнику.
      void qc.invalidateQueries({ queryKey: cashKeys.all });
      void qc.invalidateQueries({ queryKey: supplierPaymentsKeys.all });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: bankTransactionsKeys.all });
    },
  });
}

/**
 * Мутації імпорту виписки: raw-preview (сира сітка) + preview (авто-матч, multipart)
 * + apply (JSON). Файл шлеться через apiMultipartFetch (FormData; браузер сам ставить boundary).
 */
export function useBankStatementImport() {
  const qc = useQueryClient();

  const rawPreview = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return apiMultipartFetch<RawPreviewResult>('/bank-statements/import/raw-preview', fd);
    },
  });

  const preview = useMutation({
    mutationFn: ({
      file,
      bankAccountId,
      mapping,
    }: {
      file: File;
      bankAccountId: string;
      mapping: ColumnMapping;
    }) => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('bankAccountId', bankAccountId);
      fd.append('startRow', String(mapping.startRow ?? 1));
      fd.append('dateCol', String(mapping.dateCol));
      fd.append('amountCol', String(mapping.amountCol));
      fd.append('externalIdCol', String(mapping.externalIdCol));
      if (mapping.payerNameCol) fd.append('payerNameCol', String(mapping.payerNameCol));
      if (mapping.payerIbanCol) fd.append('payerIbanCol', String(mapping.payerIbanCol));
      if (mapping.payerEdrpouCol) fd.append('payerEdrpouCol', String(mapping.payerEdrpouCol));
      if (mapping.purposeCol) fd.append('purposeCol', String(mapping.purposeCol));
      const directionMode = mapping.directionMode ?? 'SIGN';
      fd.append('directionMode', directionMode);
      // Колонка списання має сенс лише «за знаком»: в інших режимах напрям задає сам режим.
      if (directionMode === 'SIGN' && mapping.debitCol)
        fd.append('debitCol', String(mapping.debitCol));
      return apiMultipartFetch<{ rows: PreviewRow[] }>('/bank-statements/import/preview', fd);
    },
  });

  const apply = useMutation({
    mutationFn: ({ bankAccountId, rows }: { bankAccountId: string; rows: ApplyRow[] }) =>
      apiFetch<ApplyImportResult>('/bank-statements/import/apply', {
        method: 'POST',
        body: JSON.stringify({ bankAccountId, rows }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: bankTransactionsKeys.all });
    },
  });

  return { rawPreview, preview, apply };
}
