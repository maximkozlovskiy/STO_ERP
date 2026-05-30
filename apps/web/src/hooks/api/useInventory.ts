import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

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
  });
}

export function useLowStockItems() {
  const { employee } = useAuth();
  return useQuery<StockItem[]>({
    queryKey: inventoryKeys.low(),
    queryFn: ({ signal }) => apiFetch('/stock-items/low', { signal }),
    enabled: !!employee,
    staleTime: 60_000,
  });
}
