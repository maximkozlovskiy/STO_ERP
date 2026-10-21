import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  PROCUREMENT_WRITE_ROLES,
  type ApiSchema,
  type SupplierOfferAllocateValues,
  type SupplierOfferSearchValues,
} from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import type { PurchaseListItem } from './usePurchaseLists';

/**
 * Пропозиції постачальників і автопідбір (docs/objects/supplier-offer.md, BR-SOFR-002…010) — ті,
 * хто веде закупівлю (OWNER, ADMIN, STOREKEEPER). Пошук іде через чергу: UI опитує легкий стан
 * batch-у (лише статуси запитів), доки в ньому є незавершені запити, а повний batch перечитує, коли
 * запит завершився; офлайн показуються останні відомі пропозиції позиції
 * (`GET /purchase-list-items/:id/offers`, BR-SOFR-003).
 */
export type SupplierOffer = ApiSchema<'SupplierOfferDto'>;
export type SupplierOfferRequest = ApiSchema<'SupplierOfferRequestDto'>;
export type SupplierOfferItem = ApiSchema<'SupplierOfferItemDto'>;
export type SupplierOfferBatch = ApiSchema<'SupplierOfferBatchDto'>;
export type SupplierOfferBatchStatus = ApiSchema<'SupplierOfferBatchStatusDto'>;
export type SupplierOfferSearchResult = ApiSchema<'SupplierOfferSearchResultDto'>;
export type SupplierAllocationResult = ApiSchema<'SupplierAllocationResultDto'>;
export type SupplierAllocationItem = ApiSchema<'SupplierAllocationItemDto'>;
export type SupplierProcurementSettings = ApiSchema<'SupplierProcurementSettingsDto'>;
export type SupplierStrategy = SupplierAllocationResult['strategy'];

/** Ролі пропозицій і автопідбору — ті самі, що в `@Roles` бекенду. */
export const SUPPLIER_OFFER_ROLES = PROCUREMENT_WRITE_ROLES;

export const supplierOffersKeys = {
  all: ['supplier-offers'] as const,
  item: (itemId: string) => [...supplierOffersKeys.all, 'item', itemId] as const,
  batch: (batchId: string) => [...supplierOffersKeys.all, 'batch', batchId] as const,
  /** Окремий префікс: скидання `batch(id)` не зачіпає опитування стану. */
  batchStatus: (batchId: string) => [...supplierOffersKeys.all, 'batch-status', batchId] as const,
  settings: () => [...supplierOffersKeys.all, 'settings'] as const,
};

/** Запит ще виконується (черга / виконання) — опитуємо часто. */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['QUEUED', 'RUNNING']);
/** Запит завершено — його пропозиції вже в БД. */
const FINAL_STATUSES: ReadonlySet<string> = new Set(['DONE', 'FAILED']);
export const OFFERS_POLL_MS = 2_000;
/** Лише «немає зв'язку — повтор о …»: опитуємо рідше, повтор однаково не раніше за nextRetryAt. */
export const OFFERS_RETRY_POLL_MS = 10_000;

/** Інтервал опитування batch-у: часто, поки є активні запити; рідше, поки лише повтори; інакше — ні. */
export function batchPollInterval(
  batch: { items: SupplierOfferItem[] } | undefined,
): number | false {
  if (!batch) return false;
  const statuses = batch.items.flatMap(i => i.requests.map(r => r.status));
  if (statuses.some(s => ACTIVE_STATUSES.has(s))) return OFFERS_POLL_MS;
  if (statuses.includes('RETRYING')) return OFFERS_RETRY_POLL_MS;
  return false;
}

/** Скільки пар «позиція × підключення» вже завершено — для прогресу автопідбору. */
export function batchProgress(batch: { items: SupplierOfferItem[] } | undefined): {
  done: number;
  total: number;
} {
  const reqs = (batch?.items ?? []).flatMap(i => i.requests);
  return {
    done: reqs.filter(r => r.status === 'DONE' || r.status === 'FAILED').length,
    total: reqs.length,
  };
}

/**
 * Легкий стан опитування — у повний batch: змінені статуси (повтор о …, помилка) підставляються
 * на місці; запит, що завершився (DONE / FAILED), — повний batch перечитується (його пропозиції).
 */
export function applyBatchStatus(
  qc: QueryClient,
  batchId: string,
  status: SupplierOfferBatchStatus,
): void {
  const key = supplierOffersKeys.batch(batchId);
  const batch = qc.getQueryData<SupplierOfferBatch>(key);
  if (!batch) return;
  const byId = new Map(status.requests.map(r => [r.id, r]));
  let changed = false;
  let finished = false;
  const items = batch.items.map(item => ({
    ...item,
    requests: item.requests.map(r => {
      const s = byId.get(r.id);
      if (
        !s ||
        (s.status === r.status &&
          s.nextRetryAt === r.nextRetryAt &&
          s.error === r.error &&
          s.fromCache === r.fromCache)
      ) {
        return r;
      }
      changed = true;
      if (FINAL_STATUSES.has(s.status) && !FINAL_STATUSES.has(r.status)) finished = true;
      return {
        ...r,
        status: s.status,
        nextRetryAt: s.nextRetryAt,
        error: s.error,
        fromCache: s.fromCache,
      };
    }),
  }));
  // Повне перечитування не переривається наступним опитуванням (cancelRefetch: false).
  if (finished) void qc.invalidateQueries({ queryKey: key, exact: true }, { cancelRefetch: false });
  else if (changed) qc.setQueryData<SupplierOfferBatch>(key, { ...batch, items });
}

/**
 * Стан пошуку пропозицій (BR-SOFR-002). Опитується легкий `…/status` (статуси запитів), а не
 * весь batch (~9 SQL + усі пропозиції кожні 2 с): повний перечитується, лише коли запит завершився.
 */
export function useSupplierOfferBatch(batchId: string | null) {
  const qc = useQueryClient();
  const batch = useQuery<SupplierOfferBatch>({
    queryKey: supplierOffersKeys.batch(batchId ?? ''),
    queryFn: ({ signal }) => apiFetch(`/supplier-offers/batches/${batchId}`, { signal }),
    enabled: !!batchId,
    // Діалоги кладуть відповідь `search` (повний batch) у кеш і лише тоді дають batchId: зі
    // staleTime 0 хук одразу перечитував той самий batch (зайвий GET на кожне відкриття).
    staleTime: OFFERS_POLL_MS,
  });
  const interval = batchPollInterval(batch.data);
  useQuery<SupplierOfferBatchStatus>({
    queryKey: supplierOffersKeys.batchStatus(batchId ?? ''),
    queryFn: async ({ signal }) => {
      const status = await apiFetch<SupplierOfferBatchStatus>(
        `/supplier-offers/batches/${batchId}/status`,
        { signal },
      );
      applyBatchStatus(qc, batchId as string, status);
      return status;
    },
    enabled: !!batchId && interval !== false,
    staleTime: 0,
    refetchInterval: interval,
  });
  return batch;
}

/** Останні відомі пропозиції позиції — без мережі постачальника (BR-SOFR-003). */
export function useItemOffers(itemId: string | null) {
  return useQuery<SupplierOfferItem>({
    queryKey: supplierOffersKeys.item(itemId ?? ''),
    queryFn: ({ signal }) => apiFetch(`/purchase-list-items/${itemId}/offers`, { signal }),
    enabled: !!itemId,
    staleTime: 0,
  });
}

/**
 * Стратегія за замовчуванням і TTL пропозиції. `enabled` — лише для ролей пропозицій: приймальня
 * відкриває «Позиції», але `GET /supplier-offers/settings` їй закритий (Bug #729 — фонове 403).
 */
export function useSupplierProcurementSettings(enabled: boolean) {
  const { employee } = useAuth();
  return useQuery<SupplierProcurementSettings>({
    queryKey: supplierOffersKeys.settings(),
    queryFn: ({ signal }) => apiFetch('/supplier-offers/settings', { signal }),
    enabled: enabled && SUPPLIER_OFFER_ROLES.includes(employee?.role ?? ''),
    staleTime: 60_000,
  });
}

const post = <T>(path: string, body?: unknown) =>
  apiFetch<T>(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

export const supplierOffersApi = {
  search: (body: SupplierOfferSearchValues) =>
    post<SupplierOfferSearchResult>('/supplier-offers/search', body),
  allocate: (body: SupplierOfferAllocateValues) =>
    post<SupplierAllocationResult>('/supplier-offers/allocate', body),
  choose: (itemId: string, offerId: string) =>
    post<PurchaseListItem>(`/purchase-list-items/${itemId}/choose-offer`, { offerId }),
  clear: (itemId: string) =>
    apiFetch<PurchaseListItem>(`/purchase-list-items/${itemId}/offer`, { method: 'DELETE' }),
};

/** Пропозиція старша за TTL — «застаріла» (BR-SOFR-003). null — TTL невідомий (роль без налаштувань). */
export function isOfferStale(
  offeredAt: string | null | undefined,
  ttlMinutes: number | undefined,
  now: Date,
): boolean | null {
  if (!offeredAt || ttlMinutes === undefined) return null;
  return now.getTime() - new Date(offeredAt).getTime() > ttlMinutes * 60_000;
}

/**
 * Термін пропозиції одним текстом — однаково в діалозі пропозицій, бейджі позиції й перегляді
 * автопідбору: 0 днів — «сьогодні», N — «N дн.», без днів — дата, інакше `fallback`.
 */
export function offerTermText(
  days: number | null,
  date: string | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
  fmt: (iso: string) => string,
  fallback: string | null = null,
): string | null {
  if (days !== null) return days === 0 ? t('offers.today') : t('offers.days', { count: days });
  return date ? fmt(date) : fallback;
}
