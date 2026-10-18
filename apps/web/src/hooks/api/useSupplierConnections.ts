import { useQuery } from '@tanstack/react-query';
import type {
  ApiSchema,
  SupplierConnectionCreateValues,
  SupplierConnectionUpdateValues,
} from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
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

const ADMIN_ROLES: readonly string[] = ['OWNER', 'ADMIN'];

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

/** Інтервал опитування, поки триває перевірка чи синхронізація (BR-SCON-004: результат пише обробник). */
export const CONNECTIONS_POLL_MS = 2_000;

export function useSupplierProviders() {
  const { employee } = useAuth();
  return useQuery<SupplierProviderInfo[]>({
    queryKey: supplierConnectionsKeys.providers(),
    queryFn: ({ signal }) => apiFetch('/supplier-providers', { signal }),
    enabled: ADMIN_ROLES.includes(employee?.role ?? ''),
    staleTime: 10 * 60_000,
  });
}

export function useSupplierConnections() {
  const { employee } = useAuth();
  return useQuery<{ items: SupplierConnection[]; total: number }>({
    queryKey: supplierConnectionsKeys.list(),
    queryFn: ({ signal }) => apiFetch('/supplier-connections', { signal }),
    enabled: ADMIN_ROLES.includes(employee?.role ?? ''),
    staleTime: 0,
    refetchInterval: query =>
      query.state.data?.items.some(connectionBusy) ? CONNECTIONS_POLL_MS : false,
  });
}

const json = (method: string, body?: unknown) => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const supplierConnectionsApi = {
  create: (body: SupplierConnectionCreateValues) =>
    apiFetch<SupplierConnection>('/supplier-connections', json('POST', body)),
  update: (id: string, body: SupplierConnectionUpdateValues) =>
    apiFetch<SupplierConnection>(`/supplier-connections/${id}`, json('PATCH', body)),
  remove: (id: string) => apiFetch<void>(`/supplier-connections/${id}`, { method: 'DELETE' }),
  verify: (id: string) =>
    apiFetch<SupplierQueuedResponse>(`/supplier-connections/${id}/verify`, json('POST')),
  catalogSync: (id: string) =>
    apiFetch<SupplierQueuedResponse>(`/supplier-connections/${id}/catalog-sync`, json('POST')),
};
