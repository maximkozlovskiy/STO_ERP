// Зміна меж запису наряду у «Дні» і збереження його форми (BR-WO-024, рішення власника
// 2026-10-18): нові межі запису сервер робить плановими датами наряду (`PATCH /calendar/slots/:id`
// — той самий шлях, що збереження наряду). Після успіху картка й списки нарядів перечитують дати
// (кеш нарядів скинуто), а вид — ланцюжок записів (сервер перебудовує продовження). Відмова —
// тост із причиною, запис повертається на місце. Запис без наряду — як раніше.

import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/__tests__/query-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarSlot } from '../calendar.types';

const params = new URLSearchParams('view=day&date=2026-10-20');
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => params,
}));

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (url: string, init?: unknown) => apiFetch(url, init),
}));

const toast = vi.hoisted(() => ({
  warning: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast }));

import { useCalendarState } from '../useCalendarState';

const NOW = new Date('2026-10-15T12:00:00+03:00');
const DAY_URL = '/calendar/slots?date=2026-10-20';

const PLAIN: CalendarSlot = {
  id: 's-1',
  liftId: 'lift-1',
  employeeId: null,
  workOrderId: null,
  startAt: new Date('2026-10-20T10:00:00+03:00').toISOString(),
  endAt: new Date('2026-10-20T11:00:00+03:00').toISOString(),
};
const WO_SLOT: CalendarSlot = {
  ...PLAIN,
  workOrderId: 'wo-1',
  workOrderNumber: 'НРД-1',
  workOrderStatus: 'APPROVED',
};

let patchError: Error | null = null;
let daySlots: CalendarSlot[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  patchError = null;
  daySlots = [PLAIN];
  toast.error.mockReset();
  apiFetch.mockReset();
  apiFetch.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === 'PATCH')
      return patchError ? Promise.reject(patchError) : Promise.resolve({});
    if (url === DAY_URL) return Promise.resolve(daySlots);
    if (url.startsWith('/calendar/slots?date=')) return Promise.resolve([]);
    if (url.startsWith('/lifts')) return Promise.resolve([{ id: 'lift-1', name: 'Пост 1' }]);
    if (url.startsWith('/settings/work-hours'))
      return Promise.resolve({ workStartHour: 8, workEndHour: 20 });
    return Promise.resolve({ items: [] });
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderDay(client: QueryClient) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(() => useCalendarState(), { wrapper });
  await waitFor(() => expect(hook.result.current.slots).toHaveLength(daySlots.length));
  await waitFor(() => expect(hook.result.current.lifts).toHaveLength(1));
  // Сітка в тесті не рендериться — ширину шкали дає заглушка елемента.
  (hook.result.current.timelineRef as { current: unknown }).current = {
    getBoundingClientRect: () => ({ width: 1200 }),
  };
  return hook;
}

const dayReads = () => apiFetch.mock.calls.filter(c => c[0] === DAY_URL).length;
const patchCall = () =>
  apiFetch.mock.calls.find(c => (c[1] as { method?: string } | undefined)?.method === 'PATCH');

/** Тягне правий край запису на `dx` px: pointerdown на ручці → pointermove → pointerup. */
async function dragEnd(hook: Awaited<ReturnType<typeof renderDay>>, dx: number) {
  act(() => {
    hook.result.current.handleResizeStart(
      { stopPropagation: () => {}, clientX: 500 } as never,
      's-1',
      'end',
    );
  });
  act(() => {
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 500 + dx }));
  });
  await act(async () => {
    window.dispatchEvent(new MouseEvent('pointerup', { clientX: 500 + dx }));
    await Promise.resolve();
  });
  await waitFor(() => expect(patchCall()).toBeDefined());
}

describe('useCalendarState — зміна меж запису наряду (BR-WO-024)', () => {
  // guards: BR-WO-024
  it('кінець запису наряду пізніше → PATCH запису з новим кінцем, кеш нарядів скинуто, вид перечитано', async () => {
    daySlots = [WO_SLOT];
    const client = makeTestQueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const hook = await renderDay(client);
    const reads = dayReads();

    await dragEnd(hook, 100);

    const [url, init] = patchCall()!;
    expect(url).toBe('/calendar/slots/s-1');
    const body = JSON.parse((init as { body: string }).body) as { startAt: string; endAt: string };
    expect(new Date(body.startAt).getTime()).toBe(new Date(WO_SLOT.startAt).getTime());
    expect(new Date(body.endAt).getTime()).toBeGreaterThan(new Date(WO_SLOT.endAt).getTime());
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['work-orders'] }));
    await waitFor(() => expect(dayReads()).toBeGreaterThan(reads));
    expect(toast.error).not.toHaveBeenCalled();
  });

  // guards: BR-WO-024
  it('сервер відмовив → тост із причиною, вид перечитано (запис на місці), кеш нарядів не чіпається', async () => {
    daySlots = [WO_SLOT];
    patchError = new Error('Підйомник вже зайнятий на цей час');
    const client = makeTestQueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const hook = await renderDay(client);
    const reads = dayReads();

    await dragEnd(hook, 100);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Підйомник вже зайнятий на цей час'),
    );
    await waitFor(() => expect(dayReads()).toBeGreaterThan(reads));
    expect(hook.result.current.slots[0]).toMatchObject({ endAt: WO_SLOT.endAt });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['work-orders'] });
  });

  // guards: BR-WO-024
  it('запис без наряду → як раніше: PATCH запису, кеш нарядів не чіпається', async () => {
    const client = makeTestQueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const hook = await renderDay(client);

    await dragEnd(hook, 100);

    expect(patchCall()![0]).toBe('/calendar/slots/s-1');
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['work-orders'] });
  });
});

describe('useCalendarState — форма запису наряду збережена (BR-WO-024)', () => {
  // guards: BR-WO-024
  it('`workOrderChanged` → кеш нарядів скинуто; без нього — ні', async () => {
    const client = makeTestQueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const hook = await renderDay(client);

    act(() => hook.result.current.handleModalSaved());
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['work-orders'] });

    act(() => hook.result.current.handleModalSaved({ workOrderChanged: true }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['work-orders'] });
  });
});
