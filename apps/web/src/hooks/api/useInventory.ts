import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import type { ApiSchema } from '@sto/shared';

export interface StockByDocumentFilter {
  warehouseId?: string;
  goodId?: string;
  from?: string;
  to?: string;
}

// Форми відповідей — зі згенерованих DTO бекенду (контролер анотований).
// Рукописні дублі розходились із контрактом; тепер єдине джерело правди — openapi.
// `Date` у DTO бекенду openapi-typescript уже віддає як `string` (format: date-time),
// тож перетворення на боці web не потрібне.

export type GoodMovementDoc = ApiSchema<'StockByDocumentGroupDto'>;
export type GoodWithDocuments = ApiSchema<'StockByDocumentGoodDto'>;

export type BatchConsumptionRow = ApiSchema<'BatchConsumptionRowDto'>;
export type GoodInBatch = ApiSchema<'StockByBatchGoodDto'>;
export type BatchGroup = ApiSchema<'StockByBatchGroupDto'>;

export type StockItem = ApiSchema<'StockItemRowDto'>;

// /stock-items/low — плоска проєкція з raw SQL: немає id/reserved/available,
// а minStock НЕ nullable (запит фільтрує `minStock IS NOT NULL`).
// Форма відрізняється від StockItem — не змішувати.
export type LowStockItem = ApiSchema<'LowStockItemDto'>;

export interface InventoryFilter {
  warehouseId?: string;
  goodId?: string;
  q?: string;
}

export interface StockMovementFilter {
  goodId?: string;
  warehouseId?: string;
  type?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export type StockMovement = ApiSchema<'StockMovementRowDto'>;

export const inventoryKeys = {
  all: ['inventory'] as const,
  items: () => [...inventoryKeys.all, 'items'] as const,
  list: (filters: InventoryFilter) => [...inventoryKeys.items(), filters] as const,
  low: () => [...inventoryKeys.all, 'low'] as const,
  byDocument: (filters: StockByDocumentFilter) =>
    [...inventoryKeys.all, 'by-document', filters] as const,
  byBatch: (filters: StockByDocumentFilter) => [...inventoryKeys.all, 'by-batch', filters] as const,
  movements: (filters: StockMovementFilter) =>
    [...inventoryKeys.all, 'movements', filters] as const,
};

export function useStockItems(filters: InventoryFilter = {}) {
  const { employee } = useAuth();
  const params = new URLSearchParams();
  if (filters.warehouseId) params.set('warehouseId', filters.warehouseId);
  if (filters.goodId) params.set('goodId', filters.goodId);
  if (filters.q) params.set('q', filters.q);
  const qs = params.toString();

  return useQuery<StockItem[]>({
    queryKey: inventoryKeys.list(filters),
    queryFn: ({ signal }) => apiFetch(`/stock-items${qs ? `?${qs}` : ''}`, { signal }),
    enabled: !!employee,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

function buildStockQuery(filters: StockByDocumentFilter): string {
  const params = new URLSearchParams();
  if (filters.warehouseId) params.set('warehouseId', filters.warehouseId);
  if (filters.goodId) params.set('goodId', filters.goodId);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

// `enabled` gate — без нього всі 3 hooks тригерились при mount у режимі 'goods',
// агрегуючи до 5000 рядків. Споживач передає `enabled: viewMode === 'documents'` (або 'batches').
export function useStockByDocument(filters: StockByDocumentFilter, enabled: boolean = true) {
  const { employee } = useAuth();
  return useQuery<{ goods: GoodWithDocuments[] }>({
    queryKey: inventoryKeys.byDocument(filters),
    queryFn: ({ signal }) =>
      apiFetch(`/stock-items/by-document${buildStockQuery(filters)}`, { signal }),
    enabled: !!employee && enabled,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useStockByBatch(filters: StockByDocumentFilter, enabled: boolean = true) {
  const { employee } = useAuth();
  return useQuery<{ batches: BatchGroup[] }>({
    queryKey: inventoryKeys.byBatch(filters),
    queryFn: ({ signal }) =>
      apiFetch(`/stock-items/by-batch${buildStockQuery(filters)}`, { signal }),
    enabled: !!employee && enabled,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useStockMovements(filters: StockMovementFilter = {}, enabled: boolean = true) {
  const { employee } = useAuth();
  const params = new URLSearchParams();
  if (filters.warehouseId) params.set('warehouseId', filters.warehouseId);
  if (filters.goodId) params.set('goodId', filters.goodId);
  if (filters.type) params.set('type', filters.type);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));
  const qs = params.toString();

  return useQuery<{ items: StockMovement[]; total: number; page: number; limit: number }>({
    queryKey: inventoryKeys.movements(filters),
    queryFn: ({ signal }) => apiFetch(`/stock-items/movements${qs ? `?${qs}` : ''}`, { signal }),
    enabled: !!employee && enabled,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useLowStockItems() {
  const { employee } = useAuth();
  return useQuery<LowStockItem[]>({
    queryKey: inventoryKeys.low(),
    queryFn: ({ signal }) => apiFetch('/stock-items/low', { signal }),
    enabled: !!employee,
    staleTime: 60_000,
  });
}
