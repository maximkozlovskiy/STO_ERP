// Вид «День», режим «Список» (BR-CAL-014): записи дня за часом початку разом із записами без
// підйомника; клік по рядку й кнопка часу (Enter/пробіл — це кнопка) відкривають запис; задачі
// дня — окремим блоком над записами.

import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CalendarDayList } from '../CalendarDayList';
import type { CalendarSlot, Lift } from '../calendar.types';
import type { CalendarTask } from '../calendar-tasks';

const NOW = new Date('2026-10-15T12:00:00+03:00').getTime();
const LIFTS: Lift[] = [
  { id: 'lift-1', name: 'Пост 1' },
  { id: 'lift-2', name: 'Пост 2' },
];

const slot = (id: string, start: string, end: string, extra: Partial<CalendarSlot> = {}) =>
  ({
    id,
    liftId: 'lift-1',
    startAt: new Date(`2026-10-15T${start}:00+03:00`).toISOString(),
    endAt: new Date(`2026-10-15T${end}:00+03:00`).toISOString(),
    ...extra,
  }) as CalendarSlot;

function renderList(slots: CalendarSlot[], tasks: CalendarTask[] = []) {
  const onOpenSlot = vi.fn();
  const onOpenTask = vi.fn();
  render(
    <CalendarDayList
      slots={slots}
      lifts={LIFTS}
      tasks={tasks}
      loading={false}
      chainEnds={new Map()}
      nowMs={NOW}
      onOpenSlot={onOpenSlot}
      onOpenTask={onOpenTask}
    />,
  );
  return { onOpenSlot, onOpenTask };
}

const rowIds = () =>
  [...screen.getByTestId('day-list-slots').querySelectorAll('tbody tr')].map(r =>
    r.getAttribute('data-slot-id'),
  );

describe('CalendarDayList (BR-CAL-014)', () => {
  // guards: BR-CAL-014
  it('записи — за часом початку, запис без підйомника теж у списку', () => {
    renderList([
      slot('late', '14:00', '15:00'),
      slot('nolift', '09:00', '10:00', { liftId: null }),
      slot('early', '08:00', '09:00', { liftId: 'lift-2' }),
    ]);
    expect(rowIds()).toEqual(['early', 'nolift', 'late']);
    const table = screen.getByTestId('day-list-slots');
    expect(within(table).getByText('Без підйомника')).toBeInTheDocument();
    expect(within(table).getByText('Пост 2')).toBeInTheDocument();
  });

  it('колонки: клієнт із телефоном, авто з номером, наряд зі станом, механік', () => {
    renderList([
      slot('a', '12:30', '14:00', {
        counterpartyName: 'Петренко',
        cpPhone: '+380501112233',
        vehicleSummary: 'Toyota Camry',
        vehiclePlate: 'AA1234BB',
        workOrderNumber: 'WO-7',
        workOrderStatus: 'IN_PROGRESS',
        employeeName: 'Іваненко Іван',
        notes: 'Заміна масла',
      }),
    ]);
    const row = screen.getByTestId('day-list-slots').querySelector('tbody tr')!;
    for (const text of [
      '12:30–14:00',
      'Петренко',
      '+380501112233',
      'Toyota Camry',
      'AA1234BB',
      'WO-7',
      'В роботі',
      'Іваненко Іван',
      'Заміна масла',
      'Робота',
    ])
      expect(within(row as HTMLElement).getByText(text)).toBeInTheDocument();
  });

  // guards: BR-CAL-014
  it('клік по рядку й Enter на кнопці часу відкривають запис', async () => {
    const s = slot('a', '09:00', '10:00');
    const { onOpenSlot } = renderList([s]);
    fireEvent.click(screen.getByTestId('day-list-slots').querySelector('tbody tr')!);
    expect(onOpenSlot).toHaveBeenCalledWith(s);
    onOpenSlot.mockClear();
    screen.getByRole('button', { name: 'Відкрити запис 09:00–10:00' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(onOpenSlot).toHaveBeenCalledTimes(1);
  });

  it('задачі дня — окремим блоком над записами, клік відкриває задачу', () => {
    const task = {
      id: 't1',
      title: 'Передзвонити клієнту',
      status: 'NEW',
      overdue: false,
      dueAt: new Date('2026-10-15T16:00:00+03:00').toISOString(),
      startAt: null,
    } as unknown as CalendarTask;
    const { onOpenTask } = renderList([], [task]);
    const tasks = screen.getByTestId('day-list-tasks');
    fireEvent.click(within(tasks).getByText('Передзвонити клієнту'));
    expect(onOpenTask).toHaveBeenCalledWith(task);
    expect(screen.getByText('На цей день записів немає.')).toBeInTheDocument();
  });
});
