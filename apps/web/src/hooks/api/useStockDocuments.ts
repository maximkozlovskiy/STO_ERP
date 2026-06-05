import { useQueryClient } from '@tanstack/react-query';
import { usePaginatedList, type PaginatedResponse } from './usePaginatedList';

export interface StockDocLine {
  id?: string;
  goodId: string;
  goodName?: string;
  goodSku?: string | null;
  unit?: string;
  unitShortName?: string;
  coefficient?: number;
  quantity: number;
  price: number | null;
}

export interface StockDoc {
  id: string;
  number: string;
  type: string;
  status: string;
  branchId: string;
  branchName?: string;
  warehouseId: string;
  warehouseName?: string;
  targetWarehouseId?: string | null;
  targetWarehouseName?: string | null;
  notes: string | null;
  confirmedAt: string | null;
  documentDate?: string | null;
  // List endpoint omits `lines` and supplies `linesCount` instead (perf: 20 docs ×
  // 1000 line rows → 0). DetailPanel triggers GET /stock-documents/:id which returns
  // full lines[]. Use `linesCount ?? lines?.length ?? 0` for the counter in table cells.
  lines?: StockDocLine[];
  linesCount?: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

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
