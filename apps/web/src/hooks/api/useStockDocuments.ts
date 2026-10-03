import { useQueryClient } from '@tanstack/react-query';
import type { ApiSchema } from '@sto/shared';
import { usePaginatedList, type PaginatedResponse } from './usePaginatedList';

/**
 * Складський документ — ЗГЕНЕРОВАНИЙ тип із OpenAPI (`pnpm run gen:api-types`).
 * Патерн — docs/PATTERNS.md, «Типи API: беремо згенероване, не пишемо своє».
 *
 * Рукописна копія була слабшою і неповною:
 *   · `type: string` / `status: string` замість union-енумів StockDocumentType /
 *     StockDocumentStatus (у DTO беку теж був `string` — виправлено разом);
 *   · бракувало `orgId`, `purchaseOrderId`, `purchaseOrderNumber`.
 *
 * Список віддає `linesCount` без `lines`, деталь — навпаки: обидва поля опційні
 * у DTO, тож лічильник у таблиці рахуємо як `linesCount ?? lines?.length ?? 0`.
 */
export type StockDoc = ApiSchema<'StockDocumentResponseDto'>;
export type StockDocLine = ApiSchema<'StockDocumentLineResponseDto'>;

/** Статус/тип документа як union — для exhaustive switch/map у UI. */
export type StockDocStatusValue = StockDoc['status'];
export type StockDocTypeValue = StockDoc['type'];

export interface StockDocsFilter extends Record<string, unknown> {
  page?: number;
  limit?: number;
  type?: string;
  status?: string;
  showDeleted?: boolean;
  dateFrom?: string;
  dateTo?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

/** @deprecated Use PaginatedResponse<StockDoc> from usePaginatedList */
export type PaginatedStockDocs = PaginatedResponse<StockDoc>;

export const stockDocsKeys = {
  all: ['stock-documents'] as const,
  lists: () => [...stockDocsKeys.all, 'list'] as const,
  list: (filters: StockDocsFilter) => [...stockDocsKeys.lists(), filters] as const,
};

export function useStockDocuments(filters: StockDocsFilter = {}) {
  // Provide defaults for page/limit so the URL always includes them
  const effectiveFilters: StockDocsFilter = {
    page: filters.page ?? 1,
    limit: filters.limit ?? 20,
    ...filters,
  };
  return usePaginatedList<StockDoc>('/stock-documents', effectiveFilters, {
    queryKey: 'stock-documents',
  });
}

export function useInvalidateStockDocuments() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: stockDocsKeys.all });
}
