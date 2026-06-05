import { renderHook, waitFor } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

// Mock apiFetch
const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

// Mock ref-cache
const getCachedMock = vi.fn();
const setCacheMock = vi.fn();
vi.mock('@/lib/ref-cache', () => ({
  getCached: (...args: unknown[]) => getCachedMock(...args),
  setCache: (...args: unknown[]) => setCacheMock(...args),
}));

import { useCachedRefData } from './useCachedRefData';

describe('useCachedRefData', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    getCachedMock.mockReset();
    setCacheMock.mockReset();
  });

  it('повертає fallback і loading=true якщо немає кешу', () => {
    getCachedMock.mockReturnValue(null);
    apiFetchMock.mockResolvedValue([]);

    const { result } = renderHook(() =>
      useCachedRefData('cache:branches', '/branches', [] as string[]),
    );

    expect(result.current.data).toEqual([]);
    expect(result.current.loading).toBe(true);
    expect(result.current.error).toBe('');
  });

  it('повертає кешовані дані одразу, loading=false', () => {
    const cached = [{ id: '1', name: 'Branch A' }];
    getCachedMock.mockReturnValue(cached);
    apiFetchMock.mockResolvedValue(cached);

    const { result } = renderHook(() =>
      useCachedRefData('cache:branches', '/branches', [] as typeof cached),
    );

    expect(result.current.data).toEqual(cached);
    expect(result.current.loading).toBe(false);
  });

  it('оновлює дані після fetch і зберігає в кеш', async () => {
    const fresh = [{ id: '2', name: 'Branch B' }];
    getCachedMock.mockReturnValue(null);
    apiFetchMock.mockResolvedValue(fresh);

    const { result } = renderHook(() =>
      useCachedRefData('cache:branches', '/branches', [] as typeof fresh),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toEqual(fresh);
    expect(setCacheMock).toHaveBeenCalledWith('cache:branches', fresh);
  });

  it('застосовує transform до raw response', async () => {
    getCachedMock.mockReturnValue(null);
    const raw = { items: [{ id: '3', name: 'Brand X' }] };
    apiFetchMock.mockResolvedValue(raw);

    const { result } = renderHook(() =>
      useCachedRefData(
        'cache:brands',
        '/brands',
        [] as { id: string; name: string }[],
        r => (r as typeof raw).items,
      ),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(raw.items);
    expect(setCacheMock).toHaveBeenCalledWith('cache:brands', raw.items);
  });

  it('встановлює error при помилці fetch', async () => {
    getCachedMock.mockReturnValue(null);
    apiFetchMock.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() =>
      useCachedRefData('cache:branches', '/branches', [] as string[]),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Network error');
  });

  it('не оновлює стан після unmount (AbortController)', async () => {
    getCachedMock.mockReturnValue(null);
    let resolvePromise!: (v: string[]) => void;
    apiFetchMock.mockImplementation(
      (_url: string, opts: { signal?: AbortSignal }) =>
        new Promise<string[]>((res, rej) => {
          resolvePromise = res;
          opts?.signal?.addEventListener('abort', () =>
            rej(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );

    const { result, unmount } = renderHook(() =>
      useCachedRefData('cache:branches', '/branches', [] as string[]),
    );

    unmount();
    // Resolve after unmount — should not update state
    resolvePromise(['late data']);

    // Give React a tick to potentially update
    await new Promise(r => setTimeout(r, 10));

    // data stays at fallback, no error thrown
    expect(result.current.data).toEqual([]);
  });
});
