// Зміна дати при відкритій формі запису (BR-CAL-018, рішення власника 2026-10-30, TECH-DEBT (б)
// №58): будь-який перехід на іншу дату чи місяць — форма без змін закривається, з незбереженими
// змінами — «Закрити форму без збереження?», відмова лишає і форму, і дату. Знімок форми — на
// відкритті; поправки, які форма робить сама, і перечитаний запис (Bug #884) змінами не є.

import { act, renderHook, waitFor } from '@testing-library/react';
import { createQueryWrapper } from '@/__tests__/query-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarSlot } from '../calendar.types';

const replace = vi.fn();
let params = new URLSearchParams('view=day&date=2026-10-20');
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => params,
}));

const apiFetch = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (url: string, init?: unknown) => apiFetch(url, init),
}));

import { EMPTY_FORM, slotFormChanged, useCalendarState } from '../useCalendarState';

const NOW = new Date('2026-10-15T12:00:00+03:00');

const slot = (id: string, start: string, end: string, extra: Partial<CalendarSlot> = {}) =>
  ({
    id,
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    liftId: 'lift-1',
    notes: '',
    ...extra,
  }) as CalendarSlot;

let byDay: Record<string, CalendarSlot[]> = {};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  params = new URLSearchParams('view=day&date=2026-10-20');
  byDay = {};
  replace.mockReset();
  apiFetch.mockReset();
  apiFetch.mockImplementation((url: string) => {
    const m = /\/calendar\/slots\?date=(\d{4}-\d{2}-\d{2})/.exec(url);
    if (m) return Promise.resolve(byDay[m[1]] ?? []);
    if (url.startsWith('/calendar/slots?from=')) return Promise.resolve([]);
    if (url.startsWith('/lifts')) return Promise.resolve([{ id: 'lift-1', name: 'П1' }]);
    if (url.startsWith('/settings/work-hours'))
      return Promise.resolve({ workStartHour: 8, workEndHour: 20 });
    return Promise.resolve({ items: [] });
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderState() {
  const hook = renderHook(() => useCalendarState(), { wrapper: createQueryWrapper() });
  await waitFor(() => expect(hook.result.current.lifts).toHaveLength(1));
  await waitFor(() => expect(hook.result.current.nowMs).toBeGreaterThan(0));
  return hook;
}

type Hook = Awaited<ReturnType<typeof renderState>>;

const dialog = (hook: Hook) => hook.result.current.dialogProps;

/** Відкрита форма нового запису з уведеною приміткою — незбережена зміна. */
function openDirtyNew(hook: Hook) {
  act(() => hook.result.current.toggleNewSlot());
  act(() => hook.result.current.setForm(f => ({ ...f, notes: 'Не зберігати' })));
  expect(hook.result.current.showAdd).toBe(true);
}

describe('slotFormChanged — незбережені зміни форми (BR-CAL-018)', () => {
  // guards: BR-CAL-018
  it('та сама форма — без змін; будь-яке поле запису — зміна; підписи клієнта й наряду — ні', () => {
    const base = { ...EMPTY_FORM, liftId: 'lift-1', startAt: '10:00', endAt: '11:00' };
    expect(slotFormChanged(base, { ...base })).toBe(false);
    expect(slotFormChanged(base, { ...base, notes: 'x' })).toBe(true);
    expect(slotFormChanged(base, { ...base, endAt: '12:00' })).toBe(true);
    expect(slotFormChanged(base, { ...base, counterpartyId: 'cp-1' })).toBe(true);
    expect(slotFormChanged(base, { ...base, counterpartyDisplay: 'Петренко' })).toBe(false);
    // Знімка немає — порівняння з порожньою формою.
    expect(slotFormChanged(null, EMPTY_FORM)).toBe(false);
    expect(slotFormChanged(null, base)).toBe(true);
  });
});

describe('useCalendarState — зміна дати при відкритій формі (BR-CAL-018)', () => {
  // guards: BR-CAL-018
  it('форма без змін: «›» закриває форму й переходить на наступний день без питання', async () => {
    const hook = await renderState();
    act(() => hook.result.current.toggleNewSlot());
    expect(hook.result.current.showAdd).toBe(true);

    act(() => hook.result.current.nextDay());

    expect(dialog(hook).open).toBe(false);
    expect(hook.result.current.showAdd).toBe(false);
    expect(hook.result.current.date).toBe('2026-10-21');
  });

  // guards: BR-CAL-018
  it('незбережені зміни: питання; «Повернутися» лишає форму й дату, «Закрити» — переходить', async () => {
    const hook = await renderState();
    openDirtyNew(hook);

    act(() => hook.result.current.setDate('2026-10-23'));
    expect(dialog(hook)).toMatchObject({
      open: true,
      title: 'Закрити форму без збереження?',
      confirmLabel: 'Закрити форму',
      cancelLabel: 'Залишитися',
    });
    // Поки питання відкрите — нічого не змінено.
    expect(hook.result.current.date).toBe('2026-10-20');
    expect(hook.result.current.showAdd).toBe(true);

    await act(async () => {
      const d = dialog(hook);
      if (d.open) d.onCancel();
    });
    expect(hook.result.current.date).toBe('2026-10-20');
    expect(hook.result.current.showAdd).toBe(true);
    expect(hook.result.current.form.notes).toBe('Не зберігати');
    expect(replace).not.toHaveBeenCalledWith(
      expect.stringContaining('2026-10-23'),
      expect.anything(),
    );

    act(() => hook.result.current.prevDay());
    await act(async () => {
      const d = dialog(hook);
      if (d.open) d.onConfirm();
    });
    expect(hook.result.current.date).toBe('2026-10-19');
    expect(hook.result.current.showAdd).toBe(false);
  });

  // guards: BR-CAL-018
  it('та сама дата («Сьогодні», коли вже сьогодні) — не перехід: форма лишається, питання немає', async () => {
    const hook = await renderState();
    openDirtyNew(hook);
    act(() => hook.result.current.setDate('2026-10-20'));
    expect(dialog(hook).open).toBe(false);
    expect(hook.result.current.showAdd).toBe(true);
    expect(hook.result.current.form.notes).toBe('Не зберігати');
  });

  // guards: BR-CAL-018
  it('«Відкрити день» / «ще N» на іншу дату, «Новий запис на цю дату» — через те саме питання', async () => {
    params = new URLSearchParams('view=month&date=2026-10-20');
    const hook = await renderState();
    openDirtyNew(hook);

    act(() => hook.result.current.openDay('2026-10-22'));
    expect(dialog(hook).open).toBe(true);
    await act(async () => {
      const d = dialog(hook);
      if (d.open) d.onCancel();
    });
    expect(hook.result.current.date).toBe('2026-10-20');
    expect(replace).not.toHaveBeenCalled();

    // «Новий запис на цю дату» — нова порожня форма замість уведеного, навіть на ту саму дату.
    act(() => hook.result.current.openNewOnDate('2026-10-20'));
    expect(dialog(hook).open).toBe(true);
    await act(async () => {
      const d = dialog(hook);
      if (d.open) d.onConfirm();
    });
    expect(hook.result.current.showAdd).toBe(true);
    expect(hook.result.current.form.notes).toBe('');

    // Нова форма без змін — «Відкрити день» іншої дати закриває її без питання.
    act(() => hook.result.current.openDay('2026-10-22'));
    expect(dialog(hook).open).toBe(false);
    expect(hook.result.current.showAdd).toBe(false);
    expect(hook.result.current.date).toBe('2026-10-22');
  });

  // guards: BR-CAL-018
  it('картка іншого запису при зміненій формі — питання; той самий запис — форма не скидається', async () => {
    const a = slot('a', '2026-10-20T10:00:00+03:00', '2026-10-20T11:00:00+03:00');
    const b = slot('b', '2026-10-22T10:00:00+03:00', '2026-10-22T11:00:00+03:00');
    byDay['2026-10-20'] = [a];
    const hook = await renderState();
    await waitFor(() => expect(hook.result.current.slots).toHaveLength(1));
    act(() => hook.result.current.handleEditSlot(a));
    act(() => hook.result.current.setForm(f => ({ ...f, notes: 'правка' })));

    // Повторний клік по тому самому запису не скидає незбережену правку.
    act(() => hook.result.current.handleEditSlot(a));
    expect(dialog(hook).open).toBe(false);
    expect(hook.result.current.form.notes).toBe('правка');

    act(() => hook.result.current.openMonthSlot(b));
    expect(dialog(hook).open).toBe(true);
    await act(async () => {
      const d = dialog(hook);
      if (d.open) d.onCancel();
    });
    expect(hook.result.current.editingSlotId).toBe('a');
    expect(hook.result.current.date).toBe('2026-10-20');

    act(() => hook.result.current.openMonthSlot(b));
    await act(async () => {
      const d = dialog(hook);
      if (d.open) d.onConfirm();
    });
    expect(hook.result.current.editingSlotId).toBe('b');
    expect(hook.result.current.date).toBe('2026-10-22');
    expect(hook.result.current.form.notes).toBe('');
  });

  // guards: BR-CAL-018
  it('поправка самої форми (adjustForm: кінець за годинами філії, єдине авто) — не зміна', async () => {
    const hook = await renderState();
    act(() => hook.result.current.toggleNewSlot());
    act(() => hook.result.current.adjustForm(f => ({ ...f, endAt: '18:00', vehicleId: 'v-1' })));
    act(() => hook.result.current.nextDay());
    expect(dialog(hook).open).toBe(false);
    expect(hook.result.current.showAdd).toBe(false);
    expect(hook.result.current.date).toBe('2026-10-21');
  });

  // guards: BR-CAL-018
  it('запис перенесено нарядом поверх форми (Bug #884) — знімок пересувається, питання немає', async () => {
    const a = slot('a', '2026-10-20T10:00:00+03:00', '2026-10-20T11:00:00+03:00');
    byDay['2026-10-20'] = [a];
    const hook = await renderState();
    await waitFor(() => expect(hook.result.current.slots).toHaveLength(1));
    act(() => hook.result.current.handleEditSlot(a));

    byDay['2026-10-20'] = [
      slot('a', '2026-10-20T13:00:00+03:00', '2026-10-20T15:00:00+03:00', { liftId: 'lift-1' }),
    ];
    act(() => hook.result.current.refreshView());
    await waitFor(() => expect(hook.result.current.form.startAt).toBe('13:00'));

    act(() => hook.result.current.nextDay());
    expect(dialog(hook).open).toBe(false);
    expect(hook.result.current.showAdd).toBe(false);
  });
});
