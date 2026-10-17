import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  ApiSchema,
  PurchaseListFromWorkOrderValues,
  PurchaseListItemsBulkUpdateValues,
  PurchaseListItemsMoveValues,
  PurchaseListMergeValues,
} from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { buildParams, usePaginatedList, type PaginatedResponse } from './usePaginatedList';

/**
 * Списки купівлі (docs/objects/purchase-list.md) — ЗГЕНЕРОВАНІ типи з OpenAPI.
 * Інвалідація сусідніх доменів (замовлення, склад, наряди) — `invalidateProcurementSideEffects`
 * у lib/cache-invalidation.ts (той імпортує ключі звідси, тож тут його не імпортуємо — без циклу).
 */
export type PurchaseList = ApiSchema<'PurchaseListResponseDto'>;
export type PurchaseListDetail = ApiSchema<'PurchaseListDetailDto'>;
export type PurchaseListItem = ApiSchema<'PurchaseListItemResponseDto'>;
export type ShortageRow = ApiSchema<'ShortageRowDto'>;
export type ShortageResponse = ApiSchema<'ShortageResponseDto'>;
export type WorkOrderProcurement = ApiSchema<'WorkOrderProcurementDto'>;
export type FromWorkOrderResult = ApiSchema<'FromWorkOrderResultDto'>;
export type CreateOrdersResult = ApiSchema<'CreateOrdersResultDto'>;
export type PurchaseListItemStatusValue = PurchaseListItem['status'];

export interface PurchaseListsFilter extends Record<string, unknown> {
  page?: number;
  limit?: number;
  status?: string;
  q?: string;
}

export interface PurchaseListItemsFilter extends Record<string, unknown> {
  page?: number;
  limit?: number;
  status?: string;
  /** UUID постачальника або 'none' — позиції без постачальника. */
  supplierId?: string;
  warehouseId?: string;
  workOrderId?: string;
  listId?: string;
  q?: string;
}

export interface ShortageFilter extends Record<string, unknown> {
  warehouseId?: string;
  workOrderId?: string;
  limit?: number;
}

export const purchaseListsKeys = {
  all: ['purchase-lists'] as const,
  lists: () => [...purchaseListsKeys.all, 'list'] as const,
  list: (f: PurchaseListsFilter) => [...purchaseListsKeys.lists(), f] as const,
  detail: (id: string) => [...purchaseListsKeys.all, 'detail', id] as const,
  items: (f: PurchaseListItemsFilter) => [...purchaseListsKeys.all, 'items', f] as const,
  shortage: (f: ShortageFilter) => [...purchaseListsKeys.all, 'shortage', f] as const,
  byWorkOrder: (id: string) => [...purchaseListsKeys.all, 'by-work-order', id] as const,
};

export function usePurchaseLists(filters: PurchaseListsFilter = {}) {
  return usePaginatedList<PurchaseList>('/purchase-lists', filters, {
    queryKey: 'purchase-lists',
  });
}

export function usePurchaseListItems(filters: PurchaseListItemsFilter) {
  const { employee } = useAuth();
  return useQuery<PaginatedResponse<PurchaseListItem>>({
    queryKey: purchaseListsKeys.items(filters),
    queryFn: ({ signal }) => apiFetch(`/purchase-list-items${buildParams(filters)}`, { signal }),
    enabled: !!employee,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useShortage(filters: ShortageFilter) {
  const { employee } = useAuth();
  return useQuery<ShortageResponse>({
    queryKey: purchaseListsKeys.shortage(filters),
    queryFn: ({ signal }) =>
      apiFetch(`/purchase-list-items/shortage${buildParams(filters)}`, { signal }),
    enabled: !!employee,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function usePurchaseListDetail(id: string | null) {
  return useQuery<PurchaseListDetail>({
    queryKey: purchaseListsKeys.detail(id ?? ''),
    queryFn: ({ signal }) => apiFetch(`/purchase-lists/${id}`, { signal }),
    enabled: !!id,
    staleTime: 10_000,
  });
}

/** Позиції списків наряду й нестача його рядків — для картки наряду. */
export function useWorkOrderProcurement(workOrderId: string | null | undefined, enabled = true) {
  return useQuery<WorkOrderProcurement>({
    queryKey: purchaseListsKeys.byWorkOrder(workOrderId ?? ''),
    queryFn: ({ signal }) =>
      apiFetch(`/purchase-list-items/by-work-order/${workOrderId}`, { signal }),
    enabled: !!workOrderId && enabled,
    // Картку відкривають після збереження рядків — стан закупівлі перечитується щоразу.
    staleTime: 0,
  });
}

// ─── Мутації (тонкі обгортки apiFetch; кеш скидає викличний компонент) ─────────

const post = <T>(path: string, body?: unknown) =>
  apiFetch<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const purchaseListsApi = {
  fromWorkOrder: (body: PurchaseListFromWorkOrderValues) =>
    post<FromWorkOrderResult>('/purchase-lists/from-work-order', body),
  createList: (body: { name?: string; warehouseId?: string; notes?: string }) =>
    post<PurchaseList>('/purchase-lists', body),
  addItem: (
    listId: string,
    body: {
      goodId: string;
      warehouseId: string;
      quantity: number;
      supplierId?: string;
      expectedPrice?: number;
    },
  ) => post<PurchaseListItem>(`/purchase-lists/${listId}/items`, body),
  merge: (body: PurchaseListMergeValues) => post<PurchaseListDetail>('/purchase-lists/merge', body),
  createOrders: (itemIds: string[]) =>
    post<CreateOrdersResult>('/purchase-lists/create-orders', { itemIds }),
  close: (id: string) => post<PurchaseList>(`/purchase-lists/${id}/close`),
  cancel: (id: string) => post<PurchaseList>(`/purchase-lists/${id}/cancel`),
  remove: (id: string) => apiFetch<void>(`/purchase-lists/${id}`, { method: 'DELETE' }),
  updateItem: (
    id: string,
    body: { quantity?: number; supplierId?: string | null; expectedPrice?: number | null },
  ) =>
    apiFetch<PurchaseListItem>(`/purchase-list-items/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  split: (id: string, quantity: number) =>
    post<PurchaseListItem[]>(`/purchase-list-items/${id}/split`, { quantity }),
  move: (body: PurchaseListItemsMoveValues) =>
    post<{ count: number }>('/purchase-list-items/move', body),
  bulkUpdate: (body: PurchaseListItemsBulkUpdateValues) =>
    post<{ count: number }>('/purchase-list-items/bulk-update', body),
  bulkCancel: (itemIds: string[]) =>
    post<{ count: number }>('/purchase-list-items/bulk-cancel', { itemIds }),
  releaseReservation: (id: string) =>
    post<{ released: number; item: PurchaseListItem }>(
      `/purchase-list-items/${id}/release-reservation`,
    ),
};
