// Стан форми запису календаря (рішення власника 2026-11-06):
// - BR-CAL-017: форма рахує години й дні філії ПІДЙОМНИКА, обраного в ній (`GET /lifts` дає
//   `branchId`), а не основної; доки години його філії не прочитано — `null` (години основної
//   філії, а не типові 09–18);
// - BR-CAL-019: частина ланцюжка ручного запису — форма знає кількість днів і кінець останньої
//   частини; видалення з переліку «Без підйомника» питає «Видалити всі N днів?».

import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
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
vi.mock('@/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { useCalendarState } from '../useCalendarState';

const NOW = new Date('2026-10-15T12:00:00+03:00');
const DAY_URL = '/calendar/slots?date=2026-10-20';
const B2 = 'b2000000-0000-4000-8000-000000000002';

const slot = (over: Partial<CalendarSlot> = {}): CalendarSlot => ({
  id: 's-1',
  liftId: 'lift-1',
  employeeId: null,
  workOrderId: null,
  startAt: new Date('2026-10-20T10:00:00+03:00').toISOString(),
  endAt: new Date('2026-10-20T11:00:00+03:00').toISOString(),
  ...over,
});

let daySlots: CalendarSlot[] = [];
let releaseB2: () => void = () => {};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  daySlots = [];
  apiFetch.mockReset();
  apiFetch.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === 'PATCH' || init?.method === 'DELETE') return Promise.resolve({});
    if (url === DAY_URL) return Promise.resolve(daySlots);
    if (url.startsWith('/calendar/slots?date=')) return Promise.resolve([]);
    if (url.startsWith('/lifts'))
      return Promise.resolve([
        // Кеш вкладки — лише поля календаря: зайве поле відповіді (`zoneId`) не потрапляє в стан.
        { id: 'lift-1', name: 'Пост 1', zoneId: 'z1' },
        { id: 'lift-2', name: 'Пост 2', zoneId: 'z2', branchId: B2 },
      ]);
    if (url === `/settings/work-hours?branchId=${B2}`)
      return new Promise(resolve => {
        releaseB2 = () =>
          resolve({ workStartHour: 7, workEndHour: 21, workDays: [1, 2, 3, 4, 5, 6] });
      });
    if (url.startsWith('/settings/work-hours'))
      return Promise.resolve({ workStartHour: 8, workEndHour: 20, workDays: [1, 2, 3, 4, 5] });
    return Promise.resolve({ items: [] });
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderDay() {
  const client = makeTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(() => useCalendarState(), { wrapper });
  await waitFor(() => expect(hook.result.current.slots).toHaveLength(daySlots.length));
  await waitFor(() => expect(hook.result.current.lifts).toHaveLength(2));
  return hook;
}

describe('useCalendarState — години філії підйомника форми (BR-CAL-017)', () => {
  // guards: BR-CAL-017
  it('підйомник іншої філії — `null` до відповіді, далі години його філії; підйомник без філії — `null`', async () => {
    const hook = await renderDay();
    expect(hook.result.current.lifts).toEqual([
      { id: 'lift-1', name: 'Пост 1' },
      { id: 'lift-2', name: 'Пост 2', branchId: B2 },
    ]);

    act(() => hook.result.current.setForm(f => ({ ...f, liftId: 'lift-2' })));
    await waitFor(() =>
      expect(apiFetch.mock.calls.some(c => c[0] === `/settings/work-hours?branchId=${B2}`)).toBe(
        true,
      ),
    );
    expect(hook.result.current.formWorkHours).toBeNull();

    await act(async () => {
      releaseB2();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(hook.result.current.formWorkHours).toEqual({
        startHour: 7,
        endHour: 21,
        workDays: [1, 2, 3, 4, 5, 6],
      }),
    );

    act(() => hook.result.current.setForm(f => ({ ...f, liftId: 'lift-1' })));
    expect(hook.result.current.formWorkHours).toBeNull();
  });
});

describe('useCalendarState — ланцюжок ручного запису (BR-CAL-019)', () => {
  const CONT = slot({
    id: 's-2',
    liftId: null,
    parentSlotId: 's-anchor',
    chainDays: 3,
    chainEndAt: '2026-10-22T09:00:00.000Z',
  });

  // guards: BR-CAL-019
  it('форма знає ланцюжок: 3 дні, не перший і не останній день, кінець останньої частини', async () => {
    daySlots = [CONT];
    const hook = await renderDay();
    act(() => hook.result.current.handleEditSlot(CONT));
    expect(hook.result.current.editingChain).toEqual({
      days: 3,
      endAt: '2026-10-22T09:00:00.000Z',
      isFirst: false,
      isLast: false,
    });
  });

  // guards: BR-CAL-019
  it('видалення частини з переліку «Без підйомника» — «Видалити всі 3 дні?» → DELETE', async () => {
    daySlots = [CONT];
    const hook = await renderDay();
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = hook.result.current.removeSlot('s-2');
    });
    await waitFor(() => expect(hook.result.current.dialogProps.open).toBe(true));
    const dialog = hook.result.current.dialogProps as { title?: string; onConfirm: () => void };
    expect(dialog.title).toBe('Видалити всі 3 дні?');
    act(() => dialog.onConfirm());
    await act(() => done);
    expect(
      apiFetch.mock.calls
        .filter(c => (c[1] as { method?: string } | undefined)?.method === 'DELETE')
        .map(c => c[0]),
    ).toEqual(['/calendar/slots/s-2']);
  });

  it('одноденний запис — без ланцюжка', async () => {
    daySlots = [slot()];
    const hook = await renderDay();
    act(() => hook.result.current.handleEditSlot(slot()));
    expect(hook.result.current.editingChain).toBeNull();
  });
});
