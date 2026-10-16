// Перетягування запису у «Дні» на інший підйомник (BR-CAL-012, рішення власника 2026-10-16):
// хук шле `dropMechanicNotOnLift: true`, сервер знімає механіка, не закріпленого за новим
// підйомником, і відповідає `mechanicDropped` — користувач бачить «Механіка знято: …». Запис без
// механіка чи переміщення в межах підйомника — без прапорця й без повідомлення.

import { act, renderHook, waitFor } from '@testing-library/react';
import type { DragEndEvent } from '@dnd-kit/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const SLOT: CalendarSlot = {
  id: 's-1',
  liftId: 'lift-1',
  employeeId: 'mech-1',
  employeeName: 'Коваль Іван',
  workOrderId: 'wo-1',
  workOrderNumber: 'НРД-1',
  workOrderStatus: 'APPROVED',
  startAt: new Date('2026-10-20T10:00:00+03:00').toISOString(),
  endAt: new Date('2026-10-20T11:00:00+03:00').toISOString(),
};

let patchResponse: Record<string, unknown> = {};
let daySlots: CalendarSlot[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  params = new URLSearchParams('view=day&date=2026-10-20');
  patchResponse = {};
  daySlots = [SLOT];
  toast.warning.mockReset();
  toast.error.mockReset();
  apiFetch.mockReset();
  apiFetch.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === 'PATCH') return Promise.resolve(patchResponse);
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

async function renderDay() {
  const hook = renderHook(() => useCalendarState());
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

const patchBody = () => {
  const call = apiFetch.mock.calls.find(c => (c[1] as { method?: string })?.method === 'PATCH');
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
