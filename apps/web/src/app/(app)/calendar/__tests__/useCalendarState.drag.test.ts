// Перетягування запису у «Дні» на інший підйомник (BR-CAL-012, рішення власника 2026-10-16):
// хук шле `dropMechanicNotOnLift: true`, сервер знімає механіка, не закріпленого за новим
// підйомником, і відповідає `mechanicDropped` — користувач бачить «Механіка знято: …». Запис без
// механіка чи переміщення в межах підйомника — без прапорця й без повідомлення.
//
// Запис НАРЯДУ (BR-WO-023, рішення власника 2026-10-18) переміщується разом із нарядом:
// `PATCH /work-orders/:id/reschedule`, а не зміна самого запису; відмова сервера — тост і запис на
// місці; після переміщення — кеш нарядів скинуто (картка показує нові дати).

import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { createQueryWrapper, makeTestQueryClient } from '@/__tests__/query-utils';
import type { DragEndEvent } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n/config';
import type { CalendarSlot } from '../calendar.types';

let params = new URLSearchParams('view=day&date=2026-10-20');
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

// Запис без наряду: перетягується як раніше — зміною самого запису (BR-CAL-012).
const SLOT: CalendarSlot = {
  id: 's-1',
  liftId: 'lift-1',
  employeeId: 'mech-1',
  employeeName: 'Коваль Іван',
  workOrderId: null,
  startAt: new Date('2026-10-20T10:00:00+03:00').toISOString(),
  endAt: new Date('2026-10-20T11:00:00+03:00').toISOString(),
};

// Запис наряду (BR-WO-023).
const WO_SLOT: CalendarSlot = {
  ...SLOT,
  workOrderId: 'wo-1',
  workOrderNumber: 'НРД-1',
  workOrderStatus: 'APPROVED',
};

let patchResponse: Record<string, unknown> = {};
let patchError: Error | null = null;
let daySlots: CalendarSlot[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  params = new URLSearchParams('view=day&date=2026-10-20');
  patchResponse = {};
  patchError = null;
  daySlots = [SLOT];
  toast.warning.mockReset();
  toast.error.mockReset();
  apiFetch.mockReset();
  apiFetch.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === 'PATCH')
      return patchError ? Promise.reject(patchError) : Promise.resolve(patchResponse);
    if (url === '/calendar/slots?date=2026-10-20') return Promise.resolve(daySlots);
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

async function renderDay(client?: QueryClient) {
  const wrapper = client
    ? ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children)
    : createQueryWrapper();
  const hook = renderHook(() => useCalendarState(), { wrapper });
  await waitFor(() => expect(hook.result.current.slots).toHaveLength(daySlots.length));
  await waitFor(() => expect(hook.result.current.lifts).toHaveLength(2));
  // Сітка в тесті не рендериться — ширину шкали дає заглушка елемента.
  (hook.result.current.timelineRef as { current: unknown }).current = {
    getBoundingClientRect: () => ({ width: 1200 }),
  };
  return hook;
}

const dropOn = (liftId: string, dx = 0) =>
  ({
    active: { id: 's-1' },
    delta: { x: dx, y: 0 },
    over: { data: { current: { liftId } } },
  }) as unknown as DragEndEvent;

const patchCall = () =>
  apiFetch.mock.calls.find(c => (c[1] as { method?: string })?.method === 'PATCH');
const patchBody = () => {
  const call = patchCall();
  return call ? (JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>) : null;
};

describe('useCalendarState — перетягування на інший підйомник (BR-CAL-012)', () => {
  // guards: BR-CAL-012
  it('механік не закріплений за новим підйомником → прапорець у запиті, тост «Механіка знято» з іменем і постом', async () => {
    patchResponse = { ...SLOT, liftId: 'lift-2', employeeId: null, mechanicDropped: true };
    const { result } = await renderDay();

    await act(() => result.current.handleDragEnd(dropOn('lift-2')));

    expect(patchBody()).toMatchObject({ liftId: 'lift-2', dropMechanicNotOnLift: true });
    expect(toast.warning).toHaveBeenCalledWith(
      'Механіка знято: Коваль Іван не закріплений за підйомником «Пост 2»',
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  // guards: BR-CAL-012
  it('механік закріплений і за новим підйомником → без повідомлення', async () => {
    patchResponse = { ...SLOT, liftId: 'lift-2' };
    const { result } = await renderDay();

    await act(() => result.current.handleDragEnd(dropOn('lift-2')));

    expect(patchBody()).toMatchObject({ liftId: 'lift-2', dropMechanicNotOnLift: true });
    expect(toast.warning).not.toHaveBeenCalled();
  });

  // guards: BR-CAL-012
  it('механік без імені (звільнений) → повідомлення без імені', async () => {
    daySlots = [{ ...SLOT, employeeName: null }];
    patchResponse = { mechanicDropped: true };
    const { result } = await renderDay();

    await act(() => result.current.handleDragEnd(dropOn('lift-2')));

    expect(toast.warning).toHaveBeenCalledWith(
      'Механіка знято: не закріплений за підйомником «Пост 2»',
    );
  });

  // guards: BR-CAL-012
  it('переміщення в межах того самого підйомника → без liftId і без прапорця', async () => {
    const { result } = await renderDay();

    await act(() => result.current.handleDragEnd(dropOn('lift-1', 100)));

    const body = patchBody();
    expect(body).not.toBeNull();
    expect(body).not.toHaveProperty('liftId');
    expect(body).not.toHaveProperty('dropMechanicNotOnLift');
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

// Рішення власника 2026-10-16, друге: причина зняття з відповіді (`mechanicDroppedReason`) —
// «у відпустці» окремим текстом; «не закріплений за підйомником» лише коли справді не закріплений.
describe('useCalendarState — текст «Механіка знято» за причиною (BR-CAL-012)', () => {
  // guards: BR-CAL-012
  it.each([
    [
      'NOT_ON_LIFT',
      'Коваль Іван',
      'Механіка знято: Коваль Іван не закріплений за підйомником «Пост 2»',
    ],
    ['ON_LEAVE', 'Коваль Іван', 'Механіка знято: Коваль Іван у відпустці'],
    ['ON_LEAVE', null, 'Механіка знято: механік у відпустці'],
    ['UNAVAILABLE', null, 'Механіка знято: механік недоступний (звільнений чи не механік)'],
    [
      'UNAVAILABLE',
      'Коваль Іван',
      'Механіка знято: Коваль Іван недоступний (звільнений чи не механік)',
    ],
  ])('причина %s, механік %s → «%s»', async (reason, name, text) => {
    daySlots = [{ ...SLOT, employeeName: name }];
    patchResponse = { mechanicDropped: true, mechanicDroppedReason: reason };
    const { result } = await renderDay();

    await act(() => result.current.handleDragEnd(dropOn('lift-2')));

    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(text);
  });

  // guards: BR-CAL-012
  it('у відпустці — без «не закріплений за підйомником»: механік міг бути закріплений', async () => {
    patchResponse = { mechanicDropped: true, mechanicDroppedReason: 'ON_LEAVE' };
    const { result } = await renderDay();

    await act(() => result.current.handleDragEnd(dropOn('lift-2')));

    const [text] = toast.warning.mock.calls[0] as [string];
    expect(text).not.toContain('не закріплений');
    expect(text).not.toContain('Пост 2');
  });
});

describe('useCalendarState — перетягування запису наряду (BR-WO-023)', () => {
  // 100 px із 1200 (мінус бічна колонка) на шкалі 08–20 — понад 15 хв, округлюється до 15 хв.
  // guards: BR-WO-023
  it('запис наряду → PATCH /work-orders/:id/reschedule (запис, новий початок, рядок), не запис календаря', async () => {
    daySlots = [WO_SLOT];
    const client = makeTestQueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = await renderDay(client);

    await act(() => result.current.handleDragEnd(dropOn('lift-1', 100)));

    const call = patchCall();
    expect(call?.[0]).toBe('/work-orders/wo-1/reschedule');
    const body = patchBody()!;
    expect(body).toMatchObject({ slotId: 's-1', liftId: 'lift-1' });
    expect(new Date(body.startAt as string).getTime()).toBeGreaterThan(
      new Date(WO_SLOT.startAt).getTime(),
    );
    expect(body).not.toHaveProperty('endAt');
    expect(apiFetch.mock.calls.some(c => c[0] === '/calendar/slots/s-1')).toBe(false);
    // Картка наряду й списки — нові дати (кеш нарядів скинуто).
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['work-orders'] });
    expect(toast.error).not.toHaveBeenCalled();
    // Вид перечитано (ланцюжок записів перебудовано на сервері).
    await waitFor(() =>
      expect(
        apiFetch.mock.calls.filter(c => c[0] === '/calendar/slots?date=2026-10-20').length,
      ).toBeGreaterThan(1),
    );
  });

  // guards: BR-WO-023
  it('на рядок іншого підйомника → liftId рядка; механіка знято → тост «Механіка знято»', async () => {
    daySlots = [WO_SLOT];
    patchResponse = { id: 'wo-1', mechanicDropped: true, mechanicDroppedReason: 'NOT_ON_LIFT' };
    const { result } = await renderDay();

    await act(() => result.current.handleDragEnd(dropOn('lift-2')));

    expect(patchBody()).toMatchObject({ slotId: 's-1', liftId: 'lift-2' });
    expect(patchBody()).not.toHaveProperty('dropMechanicNotOnLift');
    expect(toast.warning).toHaveBeenCalledWith(
      'Механіка знято: Коваль Іван не закріплений за підйомником «Пост 2»',
    );
  });

  // guards: BR-WO-023
  it('сервер відмовив (зайнятий підйомник) → тост із причиною, запис лишається на місці', async () => {
    daySlots = [WO_SLOT];
    patchError = new Error('Підйомник вже зайнятий на цей час');
    const { result } = await renderDay();
    const reads = apiFetch.mock.calls.filter(
      c => c[0] === '/calendar/slots?date=2026-10-20',
    ).length;

    await act(() => result.current.handleDragEnd(dropOn('lift-2', 100)));

    expect(toast.error).toHaveBeenCalledWith('Підйомник вже зайнятий на цей час');
    expect(result.current.slots[0]).toMatchObject({ liftId: 'lift-1', startAt: WO_SLOT.startAt });
    expect(apiFetch.mock.calls.filter(c => c[0] === '/calendar/slots?date=2026-10-20').length).toBe(
      reads,
    );
  });

  // guards: BR-WO-023
  it('у минулий день → без запиту, попередження', async () => {
    daySlots = [WO_SLOT];
    params = new URLSearchParams('view=day&date=2026-10-20');
    vi.setSystemTime(new Date('2026-10-21T12:00:00+03:00'));
    const { result } = await renderDay();

    await act(() => result.current.handleDragEnd(dropOn('lift-1', 100)));

    expect(patchCall()).toBeUndefined();
    expect(toast.warning).toHaveBeenCalled();
  });
});

// Запасний текст відмови, коли сервер не дав причини (не `Error`): мовою інтерфейсу, а не
// жорстко українською (review 2026-10-21 — рядок «Помилка переміщення слоту» лишався без i18n).
describe('useCalendarState — відмова перетягування без причини (i18n)', () => {
  const rejectPatchWithoutReason = () => {
    const free = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation((url: string, init?: { method?: string }) =>
      init?.method === 'PATCH' ? Promise.reject({ status: 500 }) : free(url, init),
    );
  };

  afterEach(async () => {
    await i18n.changeLanguage('uk');
  });

  it('uk → «Помилка переміщення слоту»', async () => {
    rejectPatchWithoutReason();
    const { result } = await renderDay();

    await act(() => result.current.handleDragEnd(dropOn('lift-2')));

    expect(toast.error).toHaveBeenCalledWith('Помилка переміщення слоту');
  });

  it('en → «Failed to move the record»', async () => {
    await i18n.changeLanguage('en');
    rejectPatchWithoutReason();
    const { result } = await renderDay();

    await act(() => result.current.handleDragEnd(dropOn('lift-2')));

    expect(toast.error).toHaveBeenCalledWith('Failed to move the record');
  });
});

describe('useCalendarState — повернута сітка «Години» (BR-CAL-014)', () => {
  // Вісь часу — вертикальна: тіло сітки 08–20 заввишки 12 × 56 px, година = 56 px.
  async function renderHours() {
    params = new URLSearchParams('view=day&date=2026-10-20&layout=hours');
    const hook = await renderDay();
    (hook.result.current.hoursTrackRef as { current: unknown }).current = {
      getBoundingClientRect: () => ({ top: 0, height: 12 * 56 }),
    };
    return hook;
  }
  const drop = (dx: number, dy: number, liftId = 'lift-1') =>
    ({
      active: { id: 's-1' },
      delta: { x: dx, y: dy },
      over: { data: { current: { liftId } } },
    }) as unknown as DragEndEvent;

  // guards: BR-CAL-014
  it('перетягування вниз на 56 px зсуває запис на годину пізніше', async () => {
    daySlots = [SLOT];
    const { result } = await renderHours();
    await act(() => result.current.handleDragEnd(drop(0, 56)));
    expect(patchCall()?.[0]).toBe('/calendar/slots/s-1');
    expect(patchBody()?.startAt).toBe(new Date('2026-10-20T11:00:00+03:00').toISOString());
  });

  // guards: BR-CAL-014
  it('вбік — лише зміна підйомника: горизонтальний зсув час не змінює', async () => {
    daySlots = [SLOT];
    const { result } = await renderHours();
    await act(() => result.current.handleDragEnd(drop(500, 0)));
    expect(patchCall()).toBeUndefined();
    await act(() => result.current.handleDragEnd(drop(500, 0, 'lift-2')));
    const body = patchBody()!;
    expect(body.liftId).toBe('lift-2');
    expect(body.startAt ?? SLOT.startAt).toBe(SLOT.startAt);
  });
});
