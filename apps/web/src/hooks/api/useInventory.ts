import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

export interface StockByDocumentFilter {
  warehouseId?: string;
  goodId?: string;
  from?: string;
  to?: string;
}

export interface GoodMovementDoc {
  documentType: string | null;
  documentId: string | null;
  docLabel: string;
  movements: { type: string; quantity: number; createdAt: string }[];
}

export interface GoodWithDocuments {
  goodId: string;
  goodName: string;
  goodSku: string | null;
  goodBrand: string | null;
  goodUnit: string;
  totalQuantity: number;
  documents: GoodMovementDoc[];
}

// Bug #458: BatchConsumption schema (packages/database/prisma/schema.prisma:1196)
// has `documentType String` + `documentId String` — both NON-null. Backend
// `byBatch()` maps them verbatim without `?? null`. Previously typed as
// `string | null` here — over-permissive, would TS-allow dead null checks.
export interface BatchConsumptionRow {
  documentType: string;
  documentId: string;
  docLabel: string;
  quantity: number;
  createdAt: string;
}

export interface GoodInBatch {
  goodId: string;
  goodName: string;
  goodSku: string | null;
  goodBrand: string | null;
  batchId: string;
  batchNumber: string | null;
  receivedQty: number;
  remainingQty: number;
  costPrice: number;
  salePrice: number;
  consumptions: BatchConsumptionRow[];
}

export interface BatchGroup {
  batchGroupKey: string;
  poNumber: string | null;
  poDate: string | null;
  warehouseName: string;
  goods: GoodInBatch[];
}

export interface StockItem {
  id: string;
  goodId: string;
  goodName: string;
  goodSku: string | null;
  unit: string;
  salePrice: number;
  warehouseId: string;
  warehouseName: string;
  quantity: number;
  reserved: number;
  available: number;
  minStock: number | null;
  isLow: boolean;
}

// /stock-items/low returns a flat projection (raw SQL) — no id/reserved/available.
// Shape differs from StockItem; do not conflate.
export interface LowStockItem {
  goodId: string;
  goodName: string;
  goodSku: string | null;
  unit: string;
  warehouseName: string;
  quantity: number;
  minStock: number;
  deficit: number;
}

export interface InventoryFilter {
  warehouseId?: string;
  goodId?: string;
  q?: string;
}

export const inventoryKeys = {
  all: ['inventory'] as const,
  items: () => [...inventoryKeys.all, 'items'] as const,
  list: (filters: InventoryFilter) => [...inventoryKeys.items(), filters] as const,
  low: () => [...inventoryKeys.all, 'low'] as const,
  byDocument: (filters: StockByDocumentFilter) =>
    [...inventoryKeys.all, 'by-document', filters] as const,
  byBatch: (filters: StockByDocumentFilter) => [...inventoryKeys.all, 'by-batch', filters] as const,
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

// Bug #457: `enabled` gate — без нього всі 3 hooks тригерились при mount у режимі 'goods',
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

export function useLowStockItems() {
  const { employee } = useAuth();
  return useQuery<LowStockItem[]>({
    queryKey: inventoryKeys.low(),
    queryFn: ({ signal }) => apiFetch('/stock-items/low', { signal }),
    enabled: !!employee,
    staleTime: 60_000,
  });
}
