// Задачі співробітникам у календарі (docs/objects/task.md, BR-TASK-007 — окремий тип, не займає
// час): смуга «Задачі» виду «День», картки задач у «Місяці» (з «ще N» і дією «Нова задача»),
// рядок легенди і хук `useCalendarTasks` — один запит на період, перечитування після змін.

import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

import { CalendarTaskStrip } from '../CalendarTaskStrip';
import { CalendarMonthView } from '../CalendarMonthView';
import { CalendarLegend } from '../CalendarLegend';
import { calendarTaskRange, useCalendarTasks } from '../useCalendarTasks';
import { buildMonthSlots } from '../calendar-month';
import type { CalendarTask } from '../calendar-tasks';
import type { CalendarSlot } from '../calendar.types';
import { notifyCalendarChanged } from '@/lib/calendar-events';

const DAY = '2026-10-20';
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00+03:00`).toISOString();
const task = (over: Partial<CalendarTask>): CalendarTask => ({
  id: 't-1',
  title: 'Перевірити гальма',
  status: 'NEW',
  priority: 'NORMAL',
  assigneeId: 'm-1',
  assigneeName: 'Коваль Іван',
  startAt: null,
  dueAt: null,
  overdue: false,
  workOrderNumber: null,
  ...over,
});

describe('смуга «Задачі» виду «День» (BR-TASK-007)', () => {
  // guards: BR-TASK-007
  it('блок за часом у сітці робочих годин, колір за станом; клік відкриває задачу', () => {
    const onOpen = vi.fn();
    const t = task({ startAt: at('10:00'), dueAt: at('12:00'), overdue: true });
    render(
      <CalendarTaskStrip tasks={[t]} date={DAY} windowStart={8} windowEnd={18} onOpen={onOpen} />,
    );

    const block = screen.getByTestId('calendar-task-block');
    expect(block.style.left).toBe('20%');
    expect(block.style.width).toBe('20%');
    expect(block).toHaveAttribute('data-tone', 'overdue');
    expect(block).toHaveAccessibleName(/Перевірити гальма.*Коваль Іван.*Нова/);
    fireEvent.click(block);
    expect(onOpen).toHaveBeenCalledWith(t);
  });

  // guards: BR-TASK-007
  it('задачі, що перетинаються, — на різних доріжках; без задач дня смуги немає', () => {
    const { rerender } = render(
      <CalendarTaskStrip
        tasks={[
          task({ id: 'a', startAt: at('10:00'), dueAt: at('12:00') }),
          task({ id: 'b', dueAt: at('11:00') }),
        ]}
        date={DAY}
        windowStart={8}
        windowEnd={18}
        onOpen={() => {}}
      />,
    );
    const tops = screen.getAllByTestId('calendar-task-block').map(b => b.style.top);
    expect(new Set(tops).size).toBe(2);

    rerender(
      <CalendarTaskStrip tasks={[]} date={DAY} windowStart={8} windowEnd={18} onOpen={() => {}} />,
    );
    expect(screen.queryByTestId('calendar-task-strip')).toBeNull();
  });
});

describe('картки задач у «Місяці» (BR-TASK-007)', () => {
  const slot = (id: string, hhmm: string): CalendarSlot => ({
    id,
    startAt: at(hhmm),
    endAt: at(hhmm),
    type: 'WORK',
    workOrderNumber: `НРД-${id}`,
  });

  function renderMonth(extra: Partial<Parameters<typeof CalendarMonthView>[0]> = {}) {
    return render(
      <CalendarMonthView
        yearMonth="2026-10"
        monthSlots={buildMonthSlots(
          [{ d: DAY, slots: [slot('1', '09:00'), slot('2', '10:00'), slot('3', '11:00')] }],
          [DAY],
        )}
        monthLoading={false}
        monthError={false}
        nowMs={new Date('2026-10-15T12:00:00+03:00').getTime()}
        onDayClick={() => {}}
        onOpenSlot={() => {}}
        {...extra}
      />,
    );
  }
  const cell = () => document.querySelector<HTMLElement>(`[data-date="${DAY}"]`)!;

  // guards: BR-TASK-007
  it('задача — окрема картка серед записів за часом; лічильники категорій і «ще N» за записами + задачами', () => {
    const onOpenTask = vi.fn();
    const t = task({ dueAt: at('08:30'), status: 'DONE' });
    renderMonth({ tasksByDay: { [DAY]: [t] }, onOpenTask });

    const c = within(cell());
    const card = c.getByTestId('month-task-card');
    expect(card).toHaveAttribute('data-tone', 'done');
    expect(card).toHaveTextContent('Перевірити гальма');
    // 3 записи + задача: показано 3 картки, четверта — у «ще 1».
    expect(c.getAllByTestId('month-slot-card')).toHaveLength(2);
    expect(c.getByText('ще 1')).toBeInTheDocument();
    fireEvent.click(card);
    expect(onOpenTask).toHaveBeenCalledWith(t);
  });

  // guards: BR-TASK-001
  it('дія «Нова задача на дату» — лише з обробником (ролі керування)', () => {
    const onNewTaskOnDate = vi.fn();
    const { unmount } = renderMonth({ onNewTaskOnDate });
    fireEvent.click(within(cell()).getByRole('button', { name: 'Нова задача на 20.10.2026' }));
    expect(onNewTaskOnDate).toHaveBeenCalledWith(DAY);
    unmount();

    renderMonth();
    expect(within(cell()).queryByTestId('month-new-task')).toBeNull();
  });
});

describe('легенда і дані задач календаря', () => {
  // guards: BR-TASK-007
  it('легенда «?» пояснює задачу окремим рядком', () => {
    render(<CalendarLegend />);
    fireEvent.click(screen.getByRole('button', { name: 'Пояснення іконок календаря' }));
    const panel = screen.getByRole('dialog', { name: 'Що означають іконки' });
    const row = panel.querySelector('[data-legend="task"]') as HTMLElement;
    expect(within(row).getByText('Задача')).toBeInTheDocument();
    expect(row).toHaveTextContent('не займає підйомник');
  });

  it('межі періоду: день — доба, місяць — від 1-го до останнього числа', () => {
    expect(calendarTaskRange('day', DAY)).toEqual({ from: DAY, to: DAY });
    expect(calendarTaskRange('month', '2026-02-10')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(calendarTaskRange('stats', DAY)).toBeNull();
  });

  describe('useCalendarTasks', () => {
    beforeEach(() => {
      apiFetchMock.mockReset();
      apiFetchMock.mockResolvedValue({
        items: [task({ dueAt: at('10:00') })],
        total: 1,
        page: 1,
        limit: 200,
      });
    });

    // guards: BR-TASK-004
    it('місяць — ОДИН запит GET /tasks з from/to; задачі розкладено за днями', async () => {
      const { result } = renderHook(() => useCalendarTasks('month', '2026-10-05'));

      await waitFor(() => expect(result.current.byDay[DAY]).toHaveLength(1));
      expect(apiFetchMock).toHaveBeenCalledTimes(1);
      const params = new URLSearchParams(String(apiFetchMock.mock.calls[0][0]).split('?')[1]);
      expect([params.get('from'), params.get('to')]).toEqual(['2026-10-01', '2026-10-31']);
    });

    // guards: BR-TASK-007
    it('після дії із задачею (notifyCalendarChanged) смуга перечитується', async () => {
      const { result } = renderHook(() => useCalendarTasks('day', DAY));
      await waitFor(() => expect(result.current.dayTasks).toHaveLength(1));

      apiFetchMock.mockResolvedValue({ items: [], total: 0, page: 1, limit: 200 });
      act(() => notifyCalendarChanged());

      await waitFor(() => expect(result.current.dayTasks).toHaveLength(0));
      expect(apiFetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
