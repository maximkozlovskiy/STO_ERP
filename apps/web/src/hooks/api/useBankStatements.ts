import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiMultipartFetch } from '@/lib/api-client';
import { usePaginatedList, type PaginatedResponse } from './usePaginatedList';

/** Тип рознесення банк-транзакції — дзеркалить BankTransactionMatchType (@prisma/client). */
export type BankTxMatchType = 'PREPAYMENT' | 'SERVICE' | 'INVOICE' | 'REFUND' | 'OTHER';

/** Статус staging-транзакції — дзеркалить BankTransactionStatus. */
export type BankTxStatus = 'UNMATCHED' | 'MATCHED' | 'IGNORED';

/** Причина авто-матчу рядка прев'ю. */
export type PreviewMatchStatus = 'matched' | 'ambiguous' | 'notFound' | 'duplicate';

/** Ознака, за якою знайдено збіг. */
export type PreviewMatchReason = 'iban' | 'edrpou' | 'purpose';

/**
 * Банк-транзакція (виписка) — дзеркалить BankTransactionResponseDto
 * (bank-statement.dto.ts + toBankTransactionResponseDto). Числа = number (Decimal→Number).
 */
export interface BankTransaction {
  id: string;
  orgId: string;
  bankAccountId: string;
  direction: string;
  amount: number;
  currencyId: string;
  amountBase?: number | null;
  rateUsed?: number | null;
  operationDate: string;
  payerName?: string | null;
  payerIban?: string | null;
  payerEdrpou?: string | null;
  purpose?: string | null;
  externalId: string;
  source: string;
  status: string;
  matchedType?: string | null;
  counterpartyId?: string | null;
  paymentId?: string | null;
  matchConfidence?: number | null;
  ignoreReason?: string | null;
  createdAt: string;
}

/** Кандидат-контрагент для ambiguous-рядка. */
export interface PreviewCandidate {
  counterpartyId: string;
  counterpartyName: string;
}

/** Один рядок прев'ю імпорту з результатом авто-матчу — дзеркалить PreviewRowDto. */
export interface PreviewRow {
  rowIndex: number;
  operationDate: string;
  amount: number;
  payerName?: string | null;
  payerIban?: string | null;
  payerEdrpou?: string | null;
  purpose?: string | null;
  externalId: string;
  matchStatus: PreviewMatchStatus;
  suggestedCounterpartyId?: string | null;
  suggestedCounterpartyName?: string | null;
  suggestedMatchType?: BankTxMatchType | null;
  suggestedInvoiceId?: string | null;
  matchReason?: PreviewMatchReason | null;
  matchConfidence?: number | null;
  candidates: PreviewCandidate[];
}

/** Мапінг колонок файлу виписки (1-based) — дзеркалить PreviewImportColumnMapping. */
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

/** Сира сітка перших рядків для column-mapping — дзеркалить parser.rawPreview(). */
export interface RawPreviewResult {
  rows: string[][];
  totalRows: number;
}

/** Рядок для apply — дзеркалить ApplyRowDto. */
export interface ApplyRow {
  externalId: string;
  operationDate: string;
  amount: number;
  payerName?: string;
  payerIban?: string;
  payerEdrpou?: string;
  purpose?: string;
  rawData?: unknown;
}

/** Результат apply — дзеркалить ApplyImportResultDto. */
export interface ApplyImportResult {
  created: number;
  skipped: number;
}

export interface MatchTransactionInput {
  counterpartyId: string;
  type: BankTxMatchType;
  invoiceId?: string;
}

export interface BankTransactionsFilter extends Record<string, unknown> {
  status?: string;
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
