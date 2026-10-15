// useCalendarState у виді «Місяць»: місяць довантажує перший день наступного (кінець ланцюжка,
// BR-CAL-008); картка відкриває запис із датою запису, минулий — за `endAt` лише для перегляду;
// після збереження перечитується місяць (BR-CAL-009).

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarSlot } from '../calendar.types';

const replace = vi.fn();
// Стабільний об'єкт між рендерами — як у Next (новий на кожен рендер перебудовував би колбеки).
let params = new URLSearchParams('view=month&date=2026-10-01');
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => params,
}));

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (url: string, init?: unknown) => apiFetch(url, init),
}));

import { useCalendarState } from '../useCalendarState';

const NOW = new Date('2026-10-15T12:00:00+03:00');

const slot = (id: string, start: string, end: string, extra: Partial<CalendarSlot> = {}) => ({
  id,
  startAt: new Date(start).toISOString(),
  endAt: new Date(end).toISOString(),
  liftId: 'lift-1',
  workOrderId: 'wo-1',
  workOrderNumber: 'WO-1',
  workOrderStatus: 'IN_PROGRESS',
  ...extra,
});

/** Слоти, які «повертає API» на кожен день. */
let byDay: Record<string, CalendarSlot[]> = {};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  params = new URLSearchParams('view=month&date=2026-10-01');
  byDay = {};
  apiFetch.mockReset();
  apiFetch.mockImplementation((url: string) => {
    const m = /\/calendar\/slots\?date=(\d{4}-\d{2}-\d{2})/.exec(url);
    if (m) return Promise.resolve(byDay[m[1]] ?? []);
    if (url.startsWith('/lifts')) return Promise.resolve([{ id: 'lift-1', name: 'П1' }]);
    if (url.startsWith('/settings/work-hours'))
      return Promise.resolve({ workStartHour: 8, workEndHour: 20 });
    return Promise.resolve({ items: [] });
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const slotCalls = () =>
  apiFetch.mock.calls.map(c => String(c[0])).filter(u => u.startsWith('/calendar/slots?date='));

async function renderMonth() {
  const hook = renderHook(() => useCalendarState());
  await waitFor(() => expect(hook.result.current.monthLoading).toBe(false));
  await waitFor(() => expect(hook.result.current.nowMs).toBeGreaterThan(0));
  return hook;
}

describe('useCalendarState — вид «Місяць»', () => {
  // guards: BR-CAL-008
  it('довантажує 1-ше число наступного місяця для кінця ланцюжка, але не показує його', async () => {
    byDay['2026-10-31'] = [slot('p', '2026-10-31T18:00:00+02:00', '2026-10-31T20:00:00+02:00')];
    byDay['2026-11-01'] = [
      slot('c', '2026-11-01T08:00:00+02:00', '2026-11-01T14:00:00+02:00', { parentSlotId: 'p' }),
    ];
    const { result } = await renderMonth();

    expect(slotCalls()).toContain('/calendar/slots?date=2026-11-01');
    expect(slotCalls()).toHaveLength(32); // 31 день жовтня + 1 листопада
    expect(result.current.monthSlots['2026-11-01']).toBeUndefined();
    const [last] = result.current.monthSlots['2026-10-31'].entries;
    expect(last.endMs).toBe(new Date('2026-11-01T14:00:00+02:00').getTime());
  });

  it('збій лише довантаженого дня не робить місяць незавантаженим', async () => {
    apiFetch.mockImplementation((url: string) =>
      url.includes('date=2026-11-01')
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(url.startsWith('/calendar') ? [] : { items: [] }),
    );
    const { result } = await renderMonth();
    expect(result.current.monthError).toBe(false);
  });

  // guards: BR-CAL-009
  it('картка відкриває запис: дата сторінки — дата запису, форма — на редагування', async () => {
    const s = slot('a', '2026-10-20T09:00:00+03:00', '2026-10-20T11:30:00+03:00', {
      counterpartyName: 'Петренко',
    });
    const { result } = await renderMonth();
    act(() => result.current.openMonthSlot(s));

    expect(result.current.date).toBe('2026-10-20');
    expect(result.current.editingSlotId).toBe('a');
    expect(result.current.showAdd).toBe(true);
    expect(result.current.form).toMatchObject({
      startAt: '09:00',
      endAt: '11:30',
      workOrderId: 'wo-1',
      workOrderDisplay: 'WO-1 · Петренко',
      liftId: 'lift-1',
    });
    expect(result.current.isEditingPast).toBe(false);
  });

  // guards: BR-CAL-009
  it('минулий запис (кінець раніше за зараз) — лише перегляд', async () => {
    const { result } = await renderMonth();
    act(() =>
      result.current.openMonthSlot(
        slot('old', '2026-10-14T09:00:00+03:00', '2026-10-14T10:00:00+03:00'),
      ),
    );
    expect(result.current.date).toBe('2026-10-14');
    expect(result.current.isEditingPast).toBe(true);
  });

  // guards: BR-CAL-009
  it('«минулий» — за кінцем: запис, що почався раніше, але ще триває, редагується', async () => {
    const { result } = await renderMonth();
    act(() =>
      result.current.openMonthSlot(
        slot('now', '2026-10-15T10:00:00+03:00', '2026-10-15T14:00:00+03:00'),
      ),
    );
    expect(result.current.isEditingPast).toBe(false);
  });

  // guards: BR-CAL-009
  it('після збереження з місяця перечитується місяць, а форма закривається', async () => {
    const { result } = await renderMonth();
    act(() =>
      result.current.openMonthSlot(
        slot('a', '2026-10-20T09:00:00+03:00', '2026-10-20T10:00:00+03:00'),
      ),
    );
    const before = slotCalls().length;
    byDay['2026-10-20'] = [slot('a', '2026-10-20T12:00:00+03:00', '2026-10-20T13:00:00+03:00')];
    act(() => result.current.handleModalSaved());

    await waitFor(() => expect(slotCalls().length).toBe(before + 32));
    expect(result.current.showAdd).toBe(false);
    expect(result.current.editingSlotId).toBeNull();
    await waitFor(() =>
      expect(result.current.monthSlots['2026-10-20']?.entries[0]?.slot.startAt).toBe(
        new Date('2026-10-20T12:00:00+03:00').toISOString(),
      ),
    );
  });

  // guards: BR-CAL-009
  it('«ще N» / «Відкрити день»: вид «День» і дата — одним оновленням URL', async () => {
    const { result } = await renderMonth();
    replace.mockClear();
    act(() => result.current.openDay('2026-10-20'));
    expect(result.current.date).toBe('2026-10-20');
    // Раніше два replace від того самого searchParams: другий повертав стару дату в URL.
    expect(replace).toHaveBeenCalledTimes(1);
    const url = new URLSearchParams(String(replace.mock.calls[0][0]).replace(/^\?/, ''));
    expect(url.get('view')).toBe('day');
    expect(url.get('date')).toBe('2026-10-20');
  });

  // guards: BR-CAL-008
  it('вид «День»: dayEntries — записи дня з кінцем ланцюжка з довантаженого наступного дня', async () => {
    params = new URLSearchParams('view=day&date=2026-10-15');
    byDay['2026-10-15'] = [slot('p', '2026-10-15T08:00:00+03:00', '2026-10-15T10:00:00+03:00')];
    byDay['2026-10-16'] = [
      slot('c', '2026-10-16T08:00:00+03:00', '2026-10-16T11:00:00+03:00', { parentSlotId: 'p' }),
    ];
    const { result } = renderHook(() => useCalendarState());
    await waitFor(() => expect(result.current.dayEntries).toHaveLength(1));
    expect(slotCalls()).toEqual(
      expect.arrayContaining([
        '/calendar/slots?date=2026-10-15',
        '/calendar/slots?date=2026-10-16',
      ]),
    );
    expect(result.current.dayEntries[0].slot.id).toBe('p');
    expect(result.current.dayEntries[0].endMs).toBe(
      new Date('2026-10-16T11:00:00+03:00').getTime(),
    );
  });

  // guards: BR-CAL-008
  it('наряд змінено з картки у формі → місяць перечитується, форма лишається відкритою', async () => {
    byDay['2026-10-20'] = [
      slot('a', '2026-10-20T09:00:00+03:00', '2026-10-20T10:00:00+03:00', {
        workOrderStatus: 'APPROVED',
      }),
    ];
    const { result } = await renderMonth();
    act(() => result.current.openMonthSlot(byDay['2026-10-20'][0]));
    byDay['2026-10-20'] = [{ ...byDay['2026-10-20'][0], workOrderStatus: 'IN_PROGRESS' }];
    act(() => result.current.refreshView());
    await waitFor(() =>
      expect(result.current.monthSlots['2026-10-20']?.entries[0]?.workOrderStatus).toBe(
        'IN_PROGRESS',
      ),
    );
    expect(result.current.showAdd).toBe(true);
    expect(result.current.editingSlotId).toBe('a');
  });

  it('«Новий запис на цю дату»: порожня форма на обрану дату', async () => {
    const { result } = await renderMonth();
    act(() => result.current.openNewOnDate('2026-10-22'));
    expect(result.current.date).toBe('2026-10-22');
    expect(result.current.editingSlotId).toBeNull();
    expect(result.current.showAdd).toBe(true);
    expect(result.current.form.workOrderId).toBe('');
  });
});
