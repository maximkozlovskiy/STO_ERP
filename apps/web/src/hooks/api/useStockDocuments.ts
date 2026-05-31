import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

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
  lines: StockDocLine[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface StockDocsFilter {
  page?: number;
  limit?: number;
  type?: string;
  status?: string;
  showDeleted?: boolean;
}

export interface PaginatedStockDocs {
  items: StockDoc[];
  total: number;
  page: number;
  limit: number;
}

export const stockDocsKeys = {
  all: ['stock-documents'] as const,
  lists: () => [...stockDocsKeys.all, 'list'] as const,
  list: (filters: StockDocsFilter) => [...stockDocsKeys.lists(), filters] as const,
};

export function useStockDocuments(filters: StockDocsFilter = {}) {
  const { employee } = useAuth();
  const params = new URLSearchParams({
    page: String(filters.page ?? 1),
    limit: String(filters.limit ?? 20),
  });
  if (filters.type) params.set('type', filters.type);
  if (filters.status) params.set('status', filters.status);
  if (filters.showDeleted) params.set('showDeleted', 'true');

  return useQuery<PaginatedStockDocs>({
    queryKey: stockDocsKeys.list(filters),
    queryFn: ({ signal }) => apiFetch(`/stock-documents?${params}`, { signal }),
    enabled: !!employee,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useInvalidateStockDocuments() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: stockDocsKeys.all });
}
