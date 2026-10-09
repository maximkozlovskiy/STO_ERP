import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import type { ApiSchema, operations } from '@sto/shared';

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

type StockMovementsQuery = NonNullable<
  operations['StockItemsController_movements_v1']['parameters']['query']
>;

export interface StockMovementFilter extends Pick<StockMovementsQuery, 'q'> {
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

// Бекенд відхиляє з 400 усе, що не `YYYY-MM-DD`. Рідний `<input type="date">` дозволяє набрати
// рік із 5–6 цифр (`20261-10-09`) — таку МЕЖУ в запит не кладемо: він іде без неї (з того боку
// вибірка не обмежена), а не мовчки застигає на помилці 400 з попередніми даними. Щоб поле не
// показувало дату, якої вибірка не знає, поля на вкладці залишків мають `max` (InventoryTab).
const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const calendarDateOrNone = (value?: string) =>
  value && CALENDAR_DATE_RE.test(value) ? value : undefined;

/** Той самий відбір іде і в ключ кешу, і в запит — інакше відкинута межа дає другий такий самий запит. */
function cleanStockFilters(filters: StockByDocumentFilter): StockByDocumentFilter {
  return {
    ...filters,
    from: calendarDateOrNone(filters.from),
    to: calendarDateOrNone(filters.to),
  };
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
  const clean = cleanStockFilters(filters);
  return useQuery<{ goods: GoodWithDocuments[] }>({
    queryKey: inventoryKeys.byDocument(clean),
    queryFn: ({ signal }) =>
      apiFetch(`/stock-items/by-document${buildStockQuery(clean)}`, { signal }),
    enabled: !!employee && enabled,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useStockByBatch(filters: StockByDocumentFilter, enabled: boolean = true) {
  const { employee } = useAuth();
  const clean = cleanStockFilters(filters);
  return useQuery<{ batches: BatchGroup[] }>({
    queryKey: inventoryKeys.byBatch(clean),
    queryFn: ({ signal }) => apiFetch(`/stock-items/by-batch${buildStockQuery(clean)}`, { signal }),
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
  if (filters.q) params.set('q', filters.q);
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

const LOW_STOCK_ROLES = ['OWNER', 'ADMIN', 'STOREKEEPER'];

export function useLowStockItems() {
  const { employee } = useAuth();
  return useQuery<LowStockItem[]>({
    queryKey: inventoryKeys.low(),
    queryFn: ({ signal }) => apiFetch('/stock-items/low', { signal }),
    // backend @Roles on /stock-items/low: other roles of the balances tab would only get 403
    enabled: !!employee && LOW_STOCK_ROLES.includes(employee.role),
    staleTime: 60_000,
  });
}
