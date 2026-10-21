import { useQuery } from '@tanstack/react-query';
import {
  SUPPLIER_CONNECTION_ADMIN_ROLES,
  type ApiSchema,
  type SupplierConnectionCreateValues,
  type SupplierConnectionUpdateValues,
} from '@sto/shared';
import { apiFetch, apiPost } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

/**
 * Підключення до API постачальників (docs/objects/supplier-connection.md, BR-SCON-001…004, 015) —
 * лише OWNER / ADMIN. Типи — згенеровані з OpenAPI.
 */
export type SupplierProviderInfo = ApiSchema<'SupplierProviderInfoDto'>;
export type SupplierFieldSpec = ApiSchema<'SupplierFieldSpecDto'>;
export type SupplierConnection = ApiSchema<'SupplierConnectionResponseDto'>;
export type SupplierQueuedResponse = ApiSchema<'SupplierQueuedResponseDto'>;
export type SupplierProviderCode = SupplierConnection['provider'];

export const supplierConnectionsKeys = {
  all: ['supplier-connections'] as const,
  list: () => [...supplierConnectionsKeys.all, 'list'] as const,
  providers: () => [...supplierConnectionsKeys.all, 'providers'] as const,
};

/** Перевірка чи синхронізація каталогу ще триває — список опитується, доки не завершиться. */
export function connectionBusy(c: SupplierConnection): boolean {
  return (
    c.verifyStatus === 'PENDING' ||
    c.catalogSyncStatus === 'QUEUED' ||
    c.catalogSyncStatus === 'RUNNING' ||
    c.catalogSyncStatus === 'RETRYING'
  );
}

/** Інтервал опитування, поки триває перевірка (BR-SCON-004: результат пише обробник за секунди). */
export const CONNECTIONS_POLL_MS = 2_000;
/** Синхронізація каталогу (BR-SCON-015) триває хвилинами — опитуємо рідше. */
export const CATALOG_SYNC_POLL_MS = 15_000;

/** Часто — поки йде перевірка; рідше — поки лише синхронізація каталогу; інакше — ні. */
export function connectionsPollInterval(items: SupplierConnection[] | undefined): number | false {
  if (!items) return false;
  if (items.some(c => c.verifyStatus === 'PENDING')) return CONNECTIONS_POLL_MS;
  return items.some(connectionBusy) ? CATALOG_SYNC_POLL_MS : false;
}

export function useSupplierProviders() {
  const { employee } = useAuth();
  return useQuery<SupplierProviderInfo[]>({
    queryKey: supplierConnectionsKeys.providers(),
    queryFn: ({ signal }) => apiFetch('/supplier-providers', { signal }),
    enabled: SUPPLIER_CONNECTION_ADMIN_ROLES.includes(employee?.role ?? ''),
    staleTime: 10 * 60_000,
  });
}

export function useSupplierConnections() {
  const { employee } = useAuth();
  return useQuery<{ items: SupplierConnection[]; total: number }>({
    queryKey: supplierConnectionsKeys.list(),
    queryFn: ({ signal }) => apiFetch('/supplier-connections', { signal }),
    enabled: SUPPLIER_CONNECTION_ADMIN_ROLES.includes(employee?.role ?? ''),
    staleTime: 0,
    refetchInterval: query => connectionsPollInterval(query.state.data?.items),
  });
}

export const supplierConnectionsApi = {
  create: (body: SupplierConnectionCreateValues) =>
    apiPost<SupplierConnection>('/supplier-connections', body),
  update: (id: string, body: SupplierConnectionUpdateValues) =>
    apiFetch<SupplierConnection>(`/supplier-connections/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  remove: (id: string) => apiFetch<void>(`/supplier-connections/${id}`, { method: 'DELETE' }),
  verify: (id: string) => apiPost<SupplierQueuedResponse>(`/supplier-connections/${id}/verify`),
  catalogSync: (id: string) =>
    apiPost<SupplierQueuedResponse>(`/supplier-connections/${id}/catalog-sync`),
};
