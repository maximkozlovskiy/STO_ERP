// Вид «День»: підсумок дня за іконками категорій — той самий рядок лічильників, що в клітинці
// місяця (BR-CAL-008; рішення власника 2026-10-15), з денних записів і кінцем ланцюжка.

import { screen, within } from '@testing-library/react';
import { renderWithQueryClient } from '@/__tests__/query-utils';
import { describe, expect, it } from 'vitest';
import { CalendarCategoryCounters } from '../CalendarCategoryCounters';
import { buildMonthSlots } from '../calendar-month';
import type { CalendarSlot } from '../calendar.types';

const NOW = new Date('2026-10-15T12:00:00+03:00').getTime();
const DAY = '2026-10-15';
const NEXT = '2026-10-16';

const slot = (
  id: string,
  start: string,
  end: string,
  workOrderStatus: string | null,
  parentSlotId: string | null = null,
): CalendarSlot => ({
  id,
  parentSlotId,
  startAt: new Date(`${start}:00+03:00`).toISOString(),
  endAt: new Date(`${end}:00+03:00`).toISOString(),
  workOrderStatus,
});

/** Як `dayEntries` у `useCalendarState`: день + довантажений наступний день. */
const dayEntries = (day: CalendarSlot[], next: CalendarSlot[] = []) =>
  buildMonthSlots(
    [
      { d: DAY, slots: day },
      { d: NEXT, slots: next },
    ],
    [DAY],
  )[DAY]?.entries ?? [];

const renderRow = (day: CalendarSlot[], next: CalendarSlot[] = []) =>
  renderWithQueryClient(
    <CalendarCategoryCounters
      entries={dayEntries(day, next)}
      nowMs={NOW}
      testId="day-categories"
    />,
  );

describe('Вид «День» — рядок лічильників дня (BR-CAL-008)', () => {
  // guards: BR-CAL-008
  it('рахує денні записи за категоріями з назвою й числом (role="img")', () => {
    renderRow([
      slot('a', '2026-10-15T08:00', '2026-10-15T09:00', 'IN_PROGRESS'),
      slot('b', '2026-10-15T09:00', '2026-10-15T10:00', 'APPROVED'),
      slot('c', '2026-10-15T13:00', '2026-10-15T14:00', 'APPROVED'),
      slot('d', '2026-10-15T15:00', '2026-10-15T16:00', 'PAID'),
      slot('e', '2026-10-15T16:00', '2026-10-15T17:00', null),
    ]);
    const row = screen.getByTestId('day-categories');
    const items = within(row)
      .getAllByRole('img')
      .map(el => el.getAttribute('aria-label'));
    expect(items).toEqual(['Прострочено: 2', 'Заплановано: 1', 'Виконано: 1', 'Без наряду: 1']);
  });

  // guards: BR-CAL-008
  it('частина сьогодні з продовженням завтра — не прострочена, хоч сама вже скінчилась', () => {
    renderRow(
      [slot('p', '2026-10-15T08:00', '2026-10-15T10:00', 'IN_PROGRESS')],
      [slot('c', '2026-10-16T08:00', '2026-10-16T11:00', 'IN_PROGRESS', 'p')],
    );
    const row = screen.getByTestId('day-categories');
    expect(within(row).getByRole('img', { name: 'В роботі: 1' })).toBeInTheDocument();
    expect(within(row).queryByRole('img', { name: /Прострочено/ })).toBeNull();
  });

  // guards: BR-CAL-008
  it('продовження сьогодні частини вчорашнього запису — за власним кінцем ланцюжка', () => {
    renderRow([slot('c', '2026-10-15T08:00', '2026-10-15T11:00', 'APPROVED', 'p')]);
    expect(screen.getByRole('img', { name: 'Прострочено: 1' })).toBeInTheDocument();
  });

  it('записи наступного дня не потрапляють у підсумок обраного дня', () => {
    renderRow(
      [slot('a', '2026-10-15T15:00', '2026-10-15T16:00', 'DRAFT')],
      [slot('b', '2026-10-16T09:00', '2026-10-16T10:00', 'PAID')],
    );
    const row = screen.getByTestId('day-categories');
    expect(within(row).getAllByRole('img')).toHaveLength(1);
    expect(within(row).getByRole('img', { name: 'Чернетка: 1' })).toBeInTheDocument();
  });

  it('день без записів — рядка немає', () => {
    renderRow([]);
    expect(screen.queryByTestId('day-categories')).toBeNull();
  });
});
