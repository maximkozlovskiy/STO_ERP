// URL-контракт пошуку й відбору за датою на сторінках документів (рішення власника 2026-10-09).
//
// Екран передає у хук `q` / дати; тут — що з цього справді потрапляє в рядок запиту:
// параметр є, коли значення задано, і його НЕМАЄ (не `q=`, не `dateFrom=`), коли воно порожнє.
//
// Mutation-verify: прибрати `params.set('q', …)` у useStockMovements / useCashOperations або
// `dateFrom`/`dateTo` в useCashOperations → відповідний кейс падає.

import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiMultipartFetch: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { id: 'emp-1', role: 'OWNER' } }),
}));

import { useStockDocuments } from './useStockDocuments';
import { useStockMovements } from './useInventory';
import { usePayments } from './usePayments';
import { useBankTransactions } from './useBankStatements';
import { useCashOperations, cashKeys } from './useCash';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

async function requestedUrl(): Promise<URL> {
  await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
  return new URL(apiFetchMock.mock.calls[0]![0] as string, 'http://x');
}

describe('пошук і дати → рядок запиту', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });
  });

  it('GET /stock-documents: q іде в запит разом із датами', async () => {
    renderHook(
      () => useStockDocuments({ q: 'СП-0001', dateFrom: '2026-10-01', dateTo: '2026-10-09' }),
      { wrapper },
    );
    const url = await requestedUrl();
    expect(url.pathname).toBe('/stock-documents');
    expect(url.searchParams.get('q')).toBe('СП-0001');
    expect(url.searchParams.get('dateFrom')).toBe('2026-10-01');
    expect(url.searchParams.get('dateTo')).toBe('2026-10-09');
  });

  it('GET /stock-items/movements: q іде в запит разом із from/to', async () => {
    renderHook(() => useStockMovements({ q: 'OIL-1', from: '2026-10-01', to: '2026-10-09' }), {
      wrapper,
    });
    const url = await requestedUrl();
    expect(url.pathname).toBe('/stock-items/movements');
    expect(url.searchParams.get('q')).toBe('OIL-1');
    expect(url.searchParams.get('from')).toBe('2026-10-01');
    expect(url.searchParams.get('to')).toBe('2026-10-09');
  });

  it('GET /payments: q іде в запит', async () => {
    renderHook(() => usePayments({ q: 'Петренко', page: 1, limit: 20 }), { wrapper });
    const url = await requestedUrl();
    expect(url.pathname).toBe('/payments');
    expect(url.searchParams.get('q')).toBe('Петренко');
  });

  it('GET /bank-statements/transactions: q, dateFrom, dateTo ідуть разом зі status і direction', async () => {
    renderHook(
      () =>
        useBankTransactions({
          status: 'UNMATCHED',
          direction: 'IN',
          q: 'UA21',
          dateFrom: '2026-09-01',
          dateTo: '2026-09-30',
        }),
      { wrapper },
    );
    const url = await requestedUrl();
    expect(url.pathname).toBe('/bank-statements/transactions');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: 'UNMATCHED',
      direction: 'IN',
      q: 'UA21',
      dateFrom: '2026-09-01',
      dateTo: '2026-09-30',
    });
  });

  it('GET /cash-registers/:id/operations: q, dateFrom, dateTo ідуть у запит', async () => {
    apiFetchMock.mockResolvedValue([]);
    renderHook(
      () =>
        useCashOperations('reg-1', { q: 'оренда', dateFrom: '2026-10-09', dateTo: '2026-10-09' }),
      { wrapper },
    );
    const url = await requestedUrl();
    expect(url.pathname).toBe('/cash-registers/reg-1/operations');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'оренда',
      dateFrom: '2026-10-09',
      dateTo: '2026-10-09',
    });
    // Запит скасовний: хук передає signal далі в apiFetch.
    expect(apiFetchMock.mock.calls[0]![1]).toEqual({ signal: expect.any(AbortSignal) });
  });

  it.each<[string, () => unknown]>([
    [
      '/stock-documents',
      () => useStockDocuments({ q: undefined, dateFrom: '', dateTo: undefined }),
    ],
    ['/stock-items/movements', () => useStockMovements({ q: undefined, from: '', to: '' })],
    ['/payments', () => usePayments({ q: undefined, dateFrom: undefined, dateTo: '' })],
    [
      '/bank-statements/transactions',
      () => useBankTransactions({ q: undefined, dateFrom: undefined, dateTo: undefined }),
    ],
    [
      '/cash-registers/reg-1/operations',
      () => useCashOperations('reg-1', { q: undefined, dateFrom: undefined, dateTo: '' }),
    ],
  ])('%s: порожні пошук і дати не надсилаються взагалі', async (path, hook) => {
    renderHook(hook, { wrapper });
    const url = await requestedUrl();
    expect(url.pathname).toBe(path);
    for (const key of ['q', 'dateFrom', 'dateTo', 'from', 'to']) {
      expect(url.searchParams.has(key)).toBe(false);
    }
  });

  it('ключ кешу операцій каси розрізняє фільтри, але лишається під префіксом каси', () => {
    const today = cashKeys.operations('reg-1', { dateFrom: '2026-10-09', dateTo: '2026-10-09' });
    const search = cashKeys.operations('reg-1', { q: 'оренда' });
    expect(JSON.stringify(today)).not.toEqual(JSON.stringify(search));
    // Мутації інвалідовують cashKeys.all — усі відфільтровані списки мають під нього потрапляти.
    expect(today.slice(0, 3)).toEqual(['cash', 'operations', 'reg-1']);
    expect(today[0]).toBe(cashKeys.all[0]);
  });

  // Поки вантажиться новий відбір, таблиця тримає попередні рядки — але лише тієї самої каси:
  // рядки каси A під назвою каси B були б неправдою.
  // Mutation-verify: `placeholderData: prev => prev` → падає крок «інша каса»;
  // прибрати placeholderData → падає крок «той самий реєстр, інший відбір».
  it('операції каси: попередні рядки лишаються при зміні відбору і зникають при зміні каси', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const stableWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const rows = [{ id: 'op-1' }];
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValueOnce(rows);
    // Наступні запити не завершуються: дивимось, що показано, ПОКИ вони йдуть.
    apiFetchMock.mockReturnValue(new Promise(() => {}));

    const { result, rerender } = renderHook(
      ({ id, q }: { id: string; q?: string }) => useCashOperations(id, { q }),
      { wrapper: stableWrapper, initialProps: { id: 'reg-1' } as { id: string; q?: string } },
    );
    await waitFor(() => expect(result.current.data).toEqual(rows));

    rerender({ id: 'reg-1', q: 'оренда' });
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data).toEqual(rows);

    rerender({ id: 'reg-2', q: 'оренда' });
    expect(result.current.data).toBeUndefined();
    expect(result.current.isPlaceholderData).toBe(false);
  });
});
