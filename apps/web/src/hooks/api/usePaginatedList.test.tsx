import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { PropsWithChildren } from 'react';
import React from 'react';

// Mock apiFetch so we can inspect the URL passed to the network layer.
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// Mock useAuth → always authenticated so usePaginatedList enables the query.
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: { id: 'e1', orgId: 'o1', role: 'OWNER' } }),
}));

import { usePaginatedList } from './usePaginatedList';

function wrapper({ children }: PropsWithChildren) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return React.createElement(QueryClientProvider, { client: qc }, children);
}

describe('usePaginatedList — buildParams via queryFn URL', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 });
  });

  function lastUrl(): string {
    const call = apiFetchMock.mock.calls.at(-1);
    if (!call) throw new Error('apiFetch not called');
    return call[0] as string;
  }

  it('empty filters → no trailing ? (Bug #297-aware)', async () => {
    const { result } = renderHook(() => usePaginatedList('/work-orders', {}), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(lastUrl()).toBe('/work-orders');
    expect(lastUrl()).not.toMatch(/\?$/);
  });

  it('false value skipped — showDeleted=false does NOT appear in URL', async () => {
    const { result } = renderHook(
      () => usePaginatedList('/work-orders', { showDeleted: false, status: 'DRAFT' }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = lastUrl();
    expect(url).toContain('status=DRAFT');
    expect(url).not.toContain('showDeleted');
  });

  it('true boolean → serialised as "true"', async () => {
    const { result } = renderHook(() => usePaginatedList('/work-orders', { showDeleted: true }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(lastUrl()).toContain('showDeleted=true');
  });

  it('null and undefined values skipped', async () => {
    const { result } = renderHook(
      () =>
        usePaginatedList('/work-orders', {
          status: null,
          q: undefined,
          page: 2,
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = lastUrl();
    expect(url).toContain('page=2');
    expect(url).not.toContain('status');
    expect(url).not.toContain('q=');
  });

  it('empty string skipped — q="" does NOT appear', async () => {
    const { result } = renderHook(() => usePaginatedList('/work-orders', { q: '', page: 1 }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = lastUrl();
    expect(url).toContain('page=1');
    expect(url).not.toContain('q=');
  });

  it('zero (0) is preserved — minStock=0 NOT skipped (UA price filter)', async () => {
    const { result } = renderHook(() => usePaginatedList('/stock-items', { minStock: 0 }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(lastUrl()).toContain('minStock=0');
  });

  it('array value → multiple params with same key', async () => {
    const { result } = renderHook(
      () => usePaginatedList('/work-orders', { status: ['DRAFT', 'IN_PROGRESS'] }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = lastUrl();
    expect(url).toContain('status=DRAFT');
    expect(url).toContain('status=IN_PROGRESS');
  });

  it('signal passed through to apiFetch for cancellation', async () => {
    const { result } = renderHook(() => usePaginatedList('/work-orders', {}), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const call = apiFetchMock.mock.calls.at(-1);
    expect(call?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
  });
});
