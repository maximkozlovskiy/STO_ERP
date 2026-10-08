import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiSchema } from '@sto/shared';
import { apiFetch, apiMultipartFetch } from '@/lib/api-client';
import { usePaginatedList, type PaginatedResponse } from './usePaginatedList';

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
}

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

export interface BankTransactionsFilter extends Record<string, unknown> {
  status?: string;
  /** Напрямок платежу: 'IN' — вхідні, 'OUT' — вихідні; без значення — усі. */
  direction?: BankTxDirection;
  page?: number;
  limit?: number;
}

export const bankTransactionsKeys = {
  all: ['bank-transactions'] as const,
};

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
