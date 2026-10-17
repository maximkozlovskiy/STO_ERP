// Форма запису після збереження наряду з його картки (BR-WO-020, Bug #884): сервер переносить
// запис наряду, календар перечитує вид — і відкрита форма бере збережені час, підйомник і механіка
// або закривається, якщо запису вже немає у виді. Інакше «Оновити» повернув би запис на старий
// час, і запис розійшовся б із плановими датами наряду.

import { act, renderHook, waitFor } from '@testing-library/react';
import { createQueryWrapper } from '@/__tests__/query-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarSlot } from '../calendar.types';
import { notifyCalendarChanged } from '@/lib/calendar-events';

let params = new URLSearchParams('view=day&date=2026-10-22');
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => params,
}));

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (url: string, init?: unknown) => apiFetch(url, init),
}));

import { useCalendarState } from '../useCalendarState';

const NOW = new Date('2026-10-16T12:00:00+03:00');

const at = (hhmm: string, day = '2026-10-22') => new Date(`${day}T${hhmm}:00+03:00`).toISOString();

const SLOT: CalendarSlot = {
  id: 's-1',
  liftId: 'lift-2',
  employeeId: null,
  workOrderId: 'wo-1',
  workOrderNumber: 'НРД-1',
  workOrderStatus: 'DRAFT',
  startAt: at('15:00'),
  endAt: at('18:00'),
};

let daySlots: CalendarSlot[] = [];
let monthDays: Record<string, CalendarSlot[]> = {};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  params = new URLSearchParams('view=day&date=2026-10-22');
  daySlots = [SLOT];
  monthDays = {};
  apiFetch.mockReset();
  apiFetch.mockImplementation((url: string) => {
    if (url === '/calendar/slots?date=2026-10-22' && params.get('view') === 'day')
      return Promise.resolve(daySlots);
    const m = /\/calendar\/slots\?date=(\d{4}-\d{2}-\d{2})/.exec(url);
    if (m) return Promise.resolve(monthDays[m[1]!] ?? []);
    if (url.startsWith('/lifts'))
      return Promise.resolve([
        { id: 'lift-1', name: 'Пост 1' },
        { id: 'lift-2', name: 'Пост 2' },
      ]);
    if (url.startsWith('/settings/work-hours'))
      return Promise.resolve({ workStartHour: 8, workEndHour: 18 });
    return Promise.resolve({ items: [] });
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function openDayForm() {
  const hook = renderHook(() => useCalendarState(), { wrapper: createQueryWrapper() });
  await waitFor(() => expect(hook.result.current.slots).toHaveLength(1));
  act(() => hook.result.current.handleEditSlot(SLOT));
  expect(hook.result.current.form).toMatchObject({ startAt: '15:00', endAt: '18:00' });
  return hook;
}

describe('useCalendarState — форма запису після збереження наряду (BR-WO-020, Bug #884)', () => {
  // guards: BR-WO-020
  it('наряд переніс запис — форма показує збережений час, підйомник і механіка', async () => {
    const { result } = await openDayForm();
    act(() => result.current.setForm(f => ({ ...f, notes: 'незбережена нотатка' })));

    daySlots = [{ ...SLOT, startAt: at('14:00'), endAt: at('17:15'), liftId: 'lift-1' }];
    act(() => notifyCalendarChanged());

    await waitFor(() => expect(result.current.form.startAt).toBe('14:00'));
    expect(result.current.showAdd).toBe(true);
    expect(result.current.form).toMatchObject({
      endAt: '17:15',
      normoHours: '3.25',
      liftId: 'lift-1',
      notes: 'незбережена нотатка',
    });
  });

  // guards: BR-WO-020
  it('запису вже немає у виді (переїхав на інший день) — форма закривається', async () => {
    const { result } = await openDayForm();

    daySlots = [];
    act(() => notifyCalendarChanged());

    await waitFor(() => expect(result.current.showAdd).toBe(false));
    expect(result.current.editingSlotId).toBeNull();
  });

  it('запис не змінився — форма не чіпається, незбережені зміни лишаються', async () => {
    const { result } = await openDayForm();
    act(() => result.current.setForm(f => ({ ...f, startAt: '16:00', notes: 'чернетка' })));

    daySlots = [{ ...SLOT }];
    act(() => result.current.refreshView());

    // Перечитаний вид — нові об'єкти записів із тими самими значеннями.
    await waitFor(() => expect(result.current.slots[0]).not.toBe(SLOT));
    expect(result.current.showAdd).toBe(true);
    expect(result.current.form).toMatchObject({ startAt: '16:00', notes: 'чернетка' });
  });

  it('збереження картки наряду в календарі — вид перечитується один раз, не двічі', async () => {
    // Картка наряду після збереження шле подію (notifyCalendarChanged) і одразу кличе onUpdated
    // форми запису (refreshView) — обидва в одному такті; вид має піти на сервер один раз.
    const { result } = await openDayForm();
    const dayCalls = () =>
      apiFetch.mock.calls.filter(([u]) => u === '/calendar/slots?date=2026-10-22').length;
    const before = dayCalls();

    act(() => {
      notifyCalendarChanged();
      result.current.refreshView();
    });

    await waitFor(() => expect(dayCalls()).toBeGreaterThan(before));
    await act(async () => {});
    expect(dayCalls() - before).toBe(1);
  });

  // guards: BR-WO-020
  it('вид «Місяць»: перенесений запис — форма й знімок запису місяця оновлюються', async () => {
    params = new URLSearchParams('view=month&date=2026-10-01');
    monthDays['2026-10-22'] = [SLOT];
    const { result } = renderHook(() => useCalendarState(), { wrapper: createQueryWrapper() });
    await waitFor(() => expect(result.current.monthSlots['2026-10-22']?.total).toBe(1));
    act(() => result.current.openMonthSlot(SLOT));

    monthDays['2026-10-22'] = [{ ...SLOT, startAt: at('09:00'), endAt: at('12:00') }];
    act(() => notifyCalendarChanged());

    await waitFor(() => expect(result.current.form.startAt).toBe('09:00'));
    expect(result.current.form.endAt).toBe('12:00');
    expect(result.current.showAdd).toBe(true);
  });
});
