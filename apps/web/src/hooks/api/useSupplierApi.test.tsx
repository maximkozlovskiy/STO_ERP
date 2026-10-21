// Хуки постачальників API: коли опитувати пошук пропозицій (BR-SOFR-002), стан передачі замовлення
// й підключень (BR-SCON-004, 012); «застаріла» пропозиція за TTL (BR-SOFR-003); які зовнішні
// статуси вимагають підтвердження скасування (BR-SCON-014); ключ і роль-гейт запиту стану.

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const apiFetch = vi.fn();
const apiPost = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  apiPost: (...a: unknown[]) => apiPost(...a),
}));
let role = 'RECEPTIONIST';
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { id: 'e1', role } }) }));

import {
  OFFERS_POLL_MS,
  OFFERS_RETRY_POLL_MS,
  batchPollInterval,
  batchProgress,
  isOfferStale,
  supplierOffersKeys,
  useSupplierOfferBatch,
  useSupplierProcurementSettings,
  type SupplierOfferBatch,
  type SupplierOfferItem,
} from './useSupplierOffers';
import {
  isSentToSupplier,
  supplierApiOrderApi,
  supplierOrderMoving,
  usePurchaseOrderSupplierApi,
  type PurchaseOrderSupplierApi,
} from './useSupplierApiOrder';
import {
  CATALOG_SYNC_POLL_MS,
  CONNECTIONS_POLL_MS,
  connectionBusy,
  connectionsPollInterval,
  type SupplierConnection,
} from './useSupplierConnections';

const item = (statuses: string[]) =>
  ({ requests: statuses.map(status => ({ status })) }) as unknown as SupplierOfferItem;

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

beforeEach(() => {
  apiFetch.mockReset();
  apiPost.mockReset();
  role = 'RECEPTIONIST';
});

describe('batchPollInterval / batchProgress (BR-SOFR-002)', () => {
  // guards: BR-SOFR-002
  it('часто — поки є черга/виконання; рідко — лише повтори; ні — все завершено', () => {
    expect(batchPollInterval({ items: [item(['DONE', 'QUEUED'])] })).toBe(OFFERS_POLL_MS);
    expect(batchPollInterval({ items: [item(['RUNNING'])] })).toBe(OFFERS_POLL_MS);
    expect(batchPollInterval({ items: [item(['DONE', 'RETRYING'])] })).toBe(OFFERS_RETRY_POLL_MS);
    expect(batchPollInterval({ items: [item(['DONE', 'FAILED'])] })).toBe(false);
    expect(batchPollInterval(undefined)).toBe(false);
    expect(
      batchProgress({ items: [item(['DONE', 'FAILED', 'RETRYING']), item(['QUEUED'])] }),
    ).toEqual({
      done: 2,
      total: 4,
    });
  });
});

describe('useSupplierOfferBatch', () => {
  // sto-optimize 2026-10-18: відповідь `search` уже є повним batch-ем і лежить у кеші — хук не
  // перечитує його одразу (раніше staleTime 0 давав зайвий GET на кожне відкриття діалогу).
  it('batch, покладений у кеш відповіддю пошуку, не перечитується одразу', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const done = { id: 'b1', items: [item(['DONE'])] };
    qc.setQueryData(supplierOffersKeys.batch('b1'), done);
    const own = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useSupplierOfferBatch('b1'), { wrapper: own });
    expect(result.current.data).toBe(done);
    await new Promise(r => setTimeout(r, 50));
    expect(apiFetch).not.toHaveBeenCalled();
  });

  // sto-simplify 2026-10-21: опитування — легкий `…/status`, а не весь batch (~9 SQL + пропозиції
  // кожні 2 с). Статуси підставляються на місці; повний batch — лише коли запит завершився.
  const req = (id: string, status: string) => ({
    id,
    status,
    nextRetryAt: null,
    error: null,
    fromCache: false,
    offers: [],
  });
  const batchOf = (...requests: ReturnType<typeof req>[]) =>
    ({ id: 'b1', items: [{ itemId: 'i1', requests }] }) as unknown as SupplierOfferBatch;
  const render = (initial: SupplierOfferBatch) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(supplierOffersKeys.batch('b1'), initial);
    const own = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    return renderHook(() => useSupplierOfferBatch('b1'), { wrapper: own });
  };
  const status = (...requests: Array<{ id: string; status: string; nextRetryAt?: string }>) => ({
    id: 'b1',
    done: false,
    completedAt: null,
    requests: requests.map(r => ({ nextRetryAt: null, error: null, fromCache: false, ...r })),
  });

  // guards: BR-SOFR-002
  it('опитується легкий стан; новий статус без завершення — на місці, без повного batch', async () => {
    apiFetch.mockImplementation((url: string) =>
      Promise.resolve(
        url.endsWith('/status')
          ? status({ id: 'r1', status: 'RETRYING', nextRetryAt: '2026-10-21T10:00:00.000Z' })
          : batchOf(req('r1', 'DONE')),
      ),
    );
    const { result } = render(batchOf(req('r1', 'QUEUED')));
    await waitFor(() =>
      expect(result.current.data?.items[0].requests[0]).toMatchObject({
        status: 'RETRYING',
        nextRetryAt: '2026-10-21T10:00:00.000Z',
      }),
    );
    const urls = apiFetch.mock.calls.map(c => c[0] as string);
    expect(urls).toContain('/supplier-offers/batches/b1/status');
    expect(urls).not.toContain('/supplier-offers/batches/b1');
  });

  // guards: BR-SOFR-002
  it('запит завершився (DONE) — повний batch перечитується з пропозиціями', async () => {
    const full = batchOf({ ...req('r1', 'DONE'), offers: [{ id: 'o1' }] as never[] });
    apiFetch.mockImplementation((url: string) =>
      Promise.resolve(url.endsWith('/status') ? status({ id: 'r1', status: 'DONE' }) : full),
    );
    const { result } = render(batchOf(req('r1', 'RUNNING')));
    await waitFor(() => expect(result.current.data).toEqual(full));
    expect(apiFetch).toHaveBeenCalledWith('/supplier-offers/batches/b1', expect.anything());
  });
});

describe('isOfferStale (BR-SOFR-003)', () => {
  // guards: BR-SOFR-003
  it('старша за TTL — застаріла; TTL невідомий — null (позначки немає)', () => {
    const now = new Date('2026-10-18T12:00:00.000Z');
    expect(isOfferStale('2026-10-18T10:59:00.000Z', 60, now)).toBe(true);
    expect(isOfferStale('2026-10-18T11:30:00.000Z', 60, now)).toBe(false);
    expect(isOfferStale('2026-10-18T10:00:00.000Z', undefined, now)).toBeNull();
    expect(isOfferStale(null, 60, now)).toBeNull();
  });
});

describe('стан передачі замовлення (BR-SCON-012, 014)', () => {
  const st = (orderStatuses: string[], summary = 'SENT') =>
    ({
      supplierApiStatus: summary,
      orders: orderStatuses.map(status => ({ status })),
    }) as unknown as PurchaseOrderSupplierApi;

  // guards: BR-SCON-014
  it('підтвердження скасування — лише коли зовнішнє замовлення вже в постачальника', () => {
    // Дзеркало бекенду SENT_SUPPLIER_ORDER_STATUSES: SENDING — відправка могла дійти.
    for (const s of [
      'SENDING',
      'PLACED',
      'CONFIRMED',
      'PARTIALLY_CONFIRMED',
      'READY',
      'SHIPPED',
      'UNKNOWN',
    ])
      expect(isSentToSupplier(st([s])), s).toBe(true);
    for (const s of ['QUEUED', 'FAILED', 'REJECTED', 'CANCELLED'])
      expect(isSentToSupplier(st([s])), s).toBe(false);
    expect(isSentToSupplier(null)).toBe(false);
  });

  it('опитування — поки відправка в черзі чи йде', () => {
    expect(supplierOrderMoving(st([], 'QUEUED'))).toBe(true);
    expect(supplierOrderMoving(st(['SENDING']))).toBe(true);
    expect(supplierOrderMoving(st(['PLACED']))).toBe(false);
  });

  it('роль без доступу до стану — запиту немає; бухгалтер — читає', async () => {
    renderHook(() => usePurchaseOrderSupplierApi('po-1'), { wrapper });
    await new Promise(r => setTimeout(r, 0));
    expect(apiFetch).not.toHaveBeenCalled();
    role = 'ACCOUNTANT';
    apiFetch.mockResolvedValue({ supplierApiStatus: 'NOT_SENT', orders: [] });
    renderHook(() => usePurchaseOrderSupplierApi('po-1'), { wrapper });
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/purchase-orders/po-1/supplier-api',
        expect.anything(),
      ),
    );
  });

  // guards: BR-SCON-009
  it('відправка — POST без тіла з Idempotency-Key', async () => {
    apiFetch.mockResolvedValue({});
    await supplierApiOrderApi.send('po-1', 'key-1');
    expect(apiFetch).toHaveBeenCalledWith('/purchase-orders/po-1/supplier-api/send', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'key-1' },
    });
  });
});

describe('інше', () => {
  // guards: BR-SCON-004
  it('підключення «зайняте», поки перевірка чи синхронізація каталогу триває', () => {
    const c = (verifyStatus: string, catalogSyncStatus: string | null) =>
      ({ verifyStatus, catalogSyncStatus }) as unknown as SupplierConnection;
    expect(connectionBusy(c('PENDING', null))).toBe(true);
    expect(connectionBusy(c('OK', 'RUNNING'))).toBe(true);
    expect(connectionBusy(c('OK', 'OK'))).toBe(false);
    expect(connectionBusy(c('FAILED', 'FAILED'))).toBe(false);
  });

  // guards: BR-SCON-004
  it('опитування підключень: часто — перевірка, рідше — лише синхронізація каталогу', () => {
    const c = (verifyStatus: string, catalogSyncStatus: string | null) =>
      ({ verifyStatus, catalogSyncStatus }) as unknown as SupplierConnection;
    expect(connectionsPollInterval([c('PENDING', null), c('OK', 'RUNNING')])).toBe(
      CONNECTIONS_POLL_MS,
    );
    expect(connectionsPollInterval([c('OK', 'RUNNING')])).toBe(CATALOG_SYNC_POLL_MS);
    expect(connectionsPollInterval([c('OK', 'OK')])).toBe(false);
    expect(connectionsPollInterval(undefined)).toBe(false);
  });

  it('налаштування закупівлі не читаються приймальнею навіть із enabled', async () => {
    renderHook(() => useSupplierProcurementSettings(true), { wrapper });
    await new Promise(r => setTimeout(r, 0));
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
