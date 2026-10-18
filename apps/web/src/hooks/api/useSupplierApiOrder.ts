import { useQuery } from '@tanstack/react-query';
import type { ApiSchema } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';

/**
 * Передача замовлення постачальнику через API (docs/objects/supplier-connection.md BR-SCON-009…014,
 * purchase-order.md BR-PO-011, 012). Стан бачать OWNER, ADMIN, STOREKEEPER, ACCOUNTANT; діють —
 * OWNER, ADMIN, STOREKEEPER.
 */
export type PurchaseOrderSupplierApi = ApiSchema<'PurchaseOrderSupplierApiDto'>;
export type SupplierApiOrder = ApiSchema<'SupplierApiOrderDto'>;
export type SupplierApiReleaseResult = ApiSchema<'SupplierApiReleaseResultDto'>;

export const SUPPLIER_API_READ_ROLES: readonly string[] = [
  'OWNER',
  'ADMIN',
  'STOREKEEPER',
  'ACCOUNTANT',
];
export const SUPPLIER_API_SEND_ROLES: readonly string[] = ['OWNER', 'ADMIN', 'STOREKEEPER'];

/**
 * Зовнішні статуси, з якими замовлення вже в постачальника — скасування чи видалення в нас
 * вимагає підтвердження (`force`, BR-SCON-014). Дзеркало списку бекенду.
 */
export const SENT_EXTERNAL_STATUSES: ReadonlySet<string> = new Set([
  'PLACED',
  'CONFIRMED',
  'PARTIALLY_CONFIRMED',
  'READY',
  'SHIPPED',
  'UNKNOWN',
]);

export function isSentToSupplier(state: PurchaseOrderSupplierApi | undefined | null): boolean {
  return (
    Array.isArray(state?.orders) && state.orders.some(o => SENT_EXTERNAL_STATUSES.has(o.status))
  );
}

export const supplierApiOrderKeys = {
  all: ['supplier-api-order'] as const,
  state: (poId: string) => [...supplierApiOrderKeys.all, poId] as const,
};

/** Відправка ще йде (черга / кроки) — стан опитується. */
const MOVING: ReadonlySet<string> = new Set(['QUEUED', 'SENDING']);
export const SUPPLIER_ORDER_POLL_MS = 3_000;

export function supplierOrderMoving(state: PurchaseOrderSupplierApi | undefined): boolean {
  if (!state) return false;
  return (
    state.supplierApiStatus === 'QUEUED' ||
    (Array.isArray(state.orders) && state.orders.some(o => MOVING.has(o.status)))
  );
}

/**
 * Стан передачі в API. `watchUntil` — мітка часу (мс), до якої опитувати й без руху відправки:
 * «Оновити статус» лише ставить задачу, відповідь постачальника прийде пізніше.
 */
export function usePurchaseOrderSupplierApi(poId: string | null, watchUntil = 0) {
  const { employee } = useAuth();
  return useQuery<PurchaseOrderSupplierApi>({
    queryKey: supplierApiOrderKeys.state(poId ?? ''),
    queryFn: ({ signal }) => apiFetch(`/purchase-orders/${poId}/supplier-api`, { signal }),
    enabled: !!poId && SUPPLIER_API_READ_ROLES.includes(employee?.role ?? ''),
    staleTime: 0,
    refetchInterval: query =>
      supplierOrderMoving(query.state.data) || Date.now() < watchUntil
        ? SUPPLIER_ORDER_POLL_MS
        : false,
  });
}

const post = <T>(path: string, headers?: Record<string, string>) =>
  apiFetch<T>(path, { method: 'POST', ...(headers ? { headers } : {}) });

export const supplierApiOrderApi = {
  get: (poId: string) =>
    apiFetch<PurchaseOrderSupplierApi>(`/purchase-orders/${poId}/supplier-api`),
  /** Idempotency-Key — повтор після обриву зв'язку не ставить другу відправку (BR-SCON-009). */
  send: (poId: string, idempotencyKey: string) =>
    post<PurchaseOrderSupplierApi>(`/purchase-orders/${poId}/supplier-api/send`, {
      'Idempotency-Key': idempotencyKey,
    }),
  poll: (poId: string) =>
    post<PurchaseOrderSupplierApi>(`/purchase-orders/${poId}/supplier-api/poll`),
  release: (poId: string) =>
    post<SupplierApiReleaseResult>(`/purchase-orders/${poId}/supplier-api/release-unconfirmed`),
};
