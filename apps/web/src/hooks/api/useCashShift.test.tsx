// Хуки зміни фіскальної каси: зміна своя в кожної каси (BR-CASH-027).
//
//   - стан питається з id каси в URL, а кеш окремий на касу: дві каси однієї філії не ділять
//     відповідь (з ключем лише за філією друга каса показала б зміну першої);
//   - без id каси запит не йде (сервер віддав би зміну будь-якої каси філії);
//   - відкриття несе id каси, після нього скидається весь кеш змін.
//
// Mutation-verify 2026-10-23: прибрати `cashRegisterId` з ключа → кейс «кеш окремий» червоний;
// з URL стану чи відкриття → відповідні кейси червоні.

import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { useCurrentShift, useOpenShift, cashShiftKeys } from './useCashShift';

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { wrapper, invalidate };
}

describe('useCurrentShift', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.includes('cashRegisterId=reg-a') ? { id: 'shift-a' } : null),
    );
  });

  // guards: BR-CASH-027
  it('URL несе філію й касу', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useCurrentShift('br-1', 'reg-a'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/cash-shifts/current?branchId=br-1&cashRegisterId=reg-a',
    );
  });

  // guards: BR-CASH-027
  it('кеш окремий на касу: друга каса тієї ж філії питає сервер і не бачить зміну першої', async () => {
    const { wrapper } = setup();
    const { result, rerender } = renderHook(
      ({ reg }: { reg: string }) => useCurrentShift('br-1', reg),
      { wrapper, initialProps: { reg: 'reg-a' } },
    );
    await waitFor(() => expect(result.current.data).toEqual({ id: 'shift-a' }));
    rerender({ reg: 'reg-b' });
    await waitFor(() => expect(result.current.data).toBeNull());
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      '/cash-shifts/current?branchId=br-1&cashRegisterId=reg-b',
    );
  });

  it('без каси чи філії запит не йде', async () => {
    const { wrapper } = setup();
    renderHook(() => useCurrentShift('br-1', null), { wrapper });
    renderHook(() => useCurrentShift(null, 'reg-a'), { wrapper });
    await new Promise(r => setTimeout(r, 0));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('useOpenShift', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ id: 'shift-b' });
  });

  // guards: BR-CASH-027
  it('POST відкриття несе касу; після успіху скидається весь кеш змін', async () => {
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useOpenShift(), { wrapper });
    await act(() => result.current.mutateAsync({ branchId: 'br-1', cashRegisterId: 'reg-b' }));
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/cash-shifts/open?branchId=br-1&cashRegisterId=reg-b',
      { method: 'POST' },
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: cashShiftKeys.all });
  });
});
