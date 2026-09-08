import { usePaginatedList, type PaginatedResponse } from './usePaginatedList';

/** Рядок логу зовнішнього обміну — дзеркалить IntegrationLogResponseDto (append-only, read-only). */
export interface IntegrationLog {
  id: string;
  branchId: string | null;
  provider: string;
  operation: string;
  ok: boolean;
  httpStatus: number | null;
  durationMs: number | null;
  documentType: string | null;
  documentId: string | null;
  error: string | null;
  createdAt: string;
}

export interface IntegrationLogsFilter extends Record<string, unknown> {
  page?: number;
  limit?: number;
  provider?: string;
  operation?: string;
  ok?: string; // 'true' | 'false' | undefined
  documentType?: string;
  dateFrom?: string;
  dateTo?: string;
}

/** @deprecated Use PaginatedResponse<IntegrationLog> */
export type PaginatedIntegrationLogs = PaginatedResponse<IntegrationLog>;

export function useIntegrationLogs(filters: IntegrationLogsFilter = {}) {
  return usePaginatedList<IntegrationLog>('/integration-logs', filters, {
    queryKey: 'integration-logs',
  });
}
