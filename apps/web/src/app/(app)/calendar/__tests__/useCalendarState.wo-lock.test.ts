// Запис наряду у «Дні» (рішення власника 2026-10-18):
// - BR-WO-027: наряд не в редагованому статусі («В роботі», «Виконано»…) — запис не тягнеться й
//   не розтягується (жодного запиту), форма отримує статус, що блокує час і підйомник;
// - BR-WO-026: видалення запису наряду з переліку «Без підйомника» попереджає, що дати наряду
//   буде стерто, і скидає кеш нарядів (картка, списки, лічильники); запис без наряду — як раніше;
//   запис наряду не в редагованому статусі не видаляється (рішення власника 2026-10-19).

import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { makeTestQueryClient } from '@/__tests__/query-utils';
import type { DragEndEvent } from '@dnd-kit/core';
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

const woSlot = (status: string, over: Partial<CalendarSlot> = {}): CalendarSlot => ({
  id: 's-1',
  liftId: 'lift-1',
  employeeId: null,
  workOrderId: 'wo-1',
  workOrderNumber: 'НРД-1',
  workOrderStatus: status,
  startAt: new Date('2026-10-20T10:00:00+03:00').toISOString(),
  endAt: new Date('2026-10-20T11:00:00+03:00').toISOString(),
  ...over,
});

let daySlots: CalendarSlot[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  daySlots = [];
  toast.warning.mockReset();
  toast.error.mockReset();
  apiFetch.mockReset();
  apiFetch.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === 'PATCH' || init?.method === 'DELETE') return Promise.resolve({});
    if (url === DAY_URL) return Promise.resolve(daySlots);
    if (url.startsWith('/calendar/slots?date=')) return Promise.resolve([]);
    if (url.startsWith('/lifts'))
      return Promise.resolve([
        { id: 'lift-1', name: 'Пост 1' },
        { id: 'lift-2', name: 'Пост 2' },
      ]);
    if (url.startsWith('/settings/work-hours'))
      return Promise.resolve({ workStartHour: 8, workEndHour: 20 });
    return Promise.resolve({ items: [] });
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderDay(client: QueryClient = makeTestQueryClient()) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(() => useCalendarState(), { wrapper });
  await waitFor(() => expect(hook.result.current.slots).toHaveLength(daySlots.length));
  await waitFor(() => expect(hook.result.current.lifts).toHaveLength(2));
  (hook.result.current.timelineRef as { current: unknown }).current = {
    getBoundingClientRect: () => ({ width: 1200 }),
  };
  return hook;
}

const writes = () =>
  apiFetch.mock.calls.filter(c => {
    const method = (c[1] as { method?: string } | undefined)?.method;
    return method === 'PATCH' || method === 'DELETE';
  });

const dropOn = (liftId: string, dx: number) =>
  ({
    active: { id: 's-1' },
    delta: { x: dx, y: 0 },
    over: { data: { current: { liftId } } },
  }) as unknown as DragEndEvent;

async function resizeEnd(hook: Awaited<ReturnType<typeof renderDay>>, dx: number) {
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
}

describe('useCalendarState — запис наряду не в редагованому статусі (BR-WO-027)', () => {
  // guards: BR-WO-027
  it.each(['IN_PROGRESS', 'ON_HOLD', 'COMPLETED'])(
    'наряд «%s»: перетягування й зміна меж — без жодного запиту',
    async status => {
      daySlots = [woSlot(status)];
      const hook = await renderDay();

      await act(() => hook.result.current.handleDragEnd(dropOn('lift-2', 200)));
      await resizeEnd(hook, 100);

      expect(writes()).toEqual([]);
      expect(hook.result.current.slots[0]).toMatchObject({ endAt: daySlots[0].endAt });
    },
  );

  // guards: BR-WO-027
  it('контроль: наряд «Затверджено» — перетягування шле reschedule наряду', async () => {
    daySlots = [woSlot('APPROVED')];
    const hook = await renderDay();

    await act(() => hook.result.current.handleDragEnd(dropOn('lift-2', 200)));

    expect(writes().map(c => c[0])).toEqual(['/work-orders/wo-1/reschedule']);
  });

  // guards: BR-WO-027
  it('форма запису: статус наряду, що блокує час і підйомник; редагований наряд і запис без наряду — ні', async () => {
    const hook = await renderDay();

    act(() => hook.result.current.handleEditSlot(woSlot('IN_PROGRESS')));
    expect(hook.result.current.editingWorkOrder).toEqual({
      number: 'НРД-1',
      lockedStatus: 'IN_PROGRESS',
    });

    act(() => hook.result.current.handleEditSlot(woSlot('ESTIMATE')));
    expect(hook.result.current.editingWorkOrder).toEqual({ number: 'НРД-1', lockedStatus: null });

    act(() =>
      hook.result.current.handleEditSlot(
        woSlot('DRAFT', { workOrderId: null, workOrderNumber: undefined }),
      ),
    );
    expect(hook.result.current.editingWorkOrder).toBeNull();
  });
});

describe('useCalendarState — видалення запису наряду з переліку (BR-WO-026)', () => {
  // guards: BR-WO-026
  it('запис наряду → підтвердження про стерті дати наряду, DELETE, кеш нарядів скинуто', async () => {
    daySlots = [woSlot('APPROVED', { liftId: null })];
    const client = makeTestQueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const hook = await renderDay(client);

    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = hook.result.current.removeSlot('s-1');
    });
    await waitFor(() => expect(hook.result.current.dialogProps.open).toBe(true));
    const dialog = hook.result.current.dialogProps as { message?: string; onConfirm: () => void };
    expect(dialog.message).toContain('НРД-1');
    expect(dialog.message).toContain('планові дати наряду');
    // Підтвердження резолвиться в оновленні стану — його треба застосувати до очікування.
    act(() => dialog.onConfirm());
    await act(() => done);

    expect(writes().map(c => [c[0], (c[1] as { method: string }).method])).toEqual([
      ['/calendar/slots/s-1', 'DELETE'],
    ]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['work-orders'] });
  });

  // Рішення власника 2026-10-19: лише в редагованому статусі наряду (сервер відповів би 400).
  // guards: BR-WO-026
  it('запис наряду «В роботі» → без підтвердження й без DELETE', async () => {
    daySlots = [woSlot('IN_PROGRESS', { liftId: null })];
    const hook = await renderDay();

    await act(() => hook.result.current.removeSlot('s-1'));

    expect(hook.result.current.dialogProps.open).toBe(false);
    expect(writes()).toEqual([]);
  });

  // guards: BR-WO-026
  it('запис без наряду → звичайне підтвердження, кеш нарядів не чіпається', async () => {
    daySlots = [woSlot('DRAFT', { liftId: null, workOrderId: null, workOrderNumber: undefined })];
    const client = makeTestQueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const hook = await renderDay(client);

    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = hook.result.current.removeSlot('s-1');
    });
    await waitFor(() => expect(hook.result.current.dialogProps.open).toBe(true));
    const dialog = hook.result.current.dialogProps as { message?: string; onConfirm: () => void };
    expect(dialog.message).not.toContain('планові дати');
    // Підтвердження резолвиться в оновленні стану — його треба застосувати до очікування.
    act(() => dialog.onConfirm());
    await act(() => done);

    expect(writes()).toHaveLength(1);
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['work-orders'] });
  });
});
