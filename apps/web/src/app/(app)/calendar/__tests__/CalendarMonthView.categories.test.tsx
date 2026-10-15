// Календар, вид «Місяць»: лічильники записів дня за категоріями з іконками (BR-CAL-008, рішення
// власника 2026-10-15 — лише категорії, без чипів подій і фільтрів).

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CalendarMonthView } from '../CalendarMonthView';
import { countCategories, slotCategory, type MonthEntry } from '../calendar-categories';
import type { MonthSlots } from '../calendar.types';

const NOW = new Date('2026-10-15T12:00:00+03:00').getTime();
const PAST = NOW - 60_000;
const FUTURE = NOW + 60_000;
const entry = (workOrderStatus: string | null, endMs = FUTURE): MonthEntry => ({
  endMs,
  workOrderStatus,
});

describe('slotCategory — категорія запису (BR-CAL-008)', () => {
  // guards: BR-CAL-008
  it.each([
    ['DRAFT', 'draft'],
    ['ESTIMATE', 'planned'],
    ['APPROVED', 'planned'],
    ['IN_PROGRESS', 'inProgress'],
    ['ON_HOLD', 'inProgress'],
    ['COMPLETED', 'done'],
    ['INVOICED', 'done'],
    ['PAID', 'done'],
    ['ARCHIVED', 'done'],
    ['CANCELLED', 'cancelled'],
  ])('майбутній запис, наряд %s → %s', (status, category) => {
    expect(slotCategory(entry(status), NOW)).toBe(category);
  });

  // guards: BR-CAL-008
  it.each(['DRAFT', 'ESTIMATE', 'APPROVED', 'IN_PROGRESS', 'ON_HOLD'])(
    'минулий запис із незавершеним нарядом %s → прострочено',
    status => {
      expect(slotCategory(entry(status, PAST), NOW)).toBe('overdue');
    },
  );

  // guards: BR-CAL-008
  it.each([
    ['COMPLETED', 'done'],
    ['PAID', 'done'],
    ['CANCELLED', 'cancelled'],
  ])('минулий запис із завершеним нарядом %s → %s, не прострочено', (status, category) => {
    expect(slotCategory(entry(status, PAST), NOW)).toBe(category);
  });

  it('запис, що закінчується саме зараз, ще не прострочений', () => {
    expect(slotCategory(entry('IN_PROGRESS', NOW), NOW)).toBe('inProgress');
  });

  // guards: BR-CAL-008
  it('запис без наряду (обслуговування, перерва) → «без наряду», навіть у минулому', () => {
    expect(slotCategory(entry(null, PAST), NOW)).toBe('other');
  });

  // guards: BR-CAL-008
  it('до гідратації (nowMs = 0) «прострочено» не ставиться — запис у категорії свого наряду', () => {
    expect(slotCategory(entry('IN_PROGRESS', PAST), 0)).toBe('inProgress');
    expect(slotCategory(entry('APPROVED', PAST), 0)).toBe('planned');
  });

  it('невідомий статус (зокрема ключ прототипу) → «без наряду», не падає', () => {
    expect(slotCategory(entry('toString'), NOW)).toBe('other');
    expect(slotCategory(entry('NEW_STATUS', PAST), NOW)).toBe('other');
  });

  it('countCategories рахує кожну категорію окремо', () => {
    expect(
      countCategories(
        [entry('IN_PROGRESS', PAST), entry('APPROVED', PAST), entry('PAID'), entry(null)],
        NOW,
      ),
    ).toEqual({ overdue: 2, done: 1, other: 1 });
  });
});

describe('CalendarMonthView — рядок лічильників дня', () => {
  const renderMonth = (slots: MonthSlots) =>
    render(
      <CalendarMonthView
        yearMonth="2026-10"
        monthSlots={slots}
        monthLoading={false}
        monthError={false}
        nowMs={NOW}
        onDayClick={() => {}}
      />,
    );

  // guards: BR-CAL-008
  it('показує лише ненульові категорії в порядку: прострочено, в роботі, … виконано', () => {
    const entries = [
      entry('PAID'),
      entry('IN_PROGRESS', PAST),
      entry('IN_PROGRESS', PAST),
      entry('IN_PROGRESS'),
    ];
    renderMonth({ '2026-10-14': { total: entries.length, byLift: {}, entries } });

    const row = screen.getByTestId('month-day-categories');
    const items = within(row)
      .getAllByLabelText(/: \d+$/)
      .map(el => el.getAttribute('data-category'));
    expect(items).toEqual(['overdue', 'inProgress', 'done']);
    // role="img" — інакше aria-label на span читач екрана не озвучує
    expect(within(row).getByRole('img', { name: 'Прострочено: 2' })).toHaveTextContent('2');
    expect(within(row).getByRole('img', { name: 'В роботі: 1' })).toHaveTextContent('1');
    expect(within(row).getByRole('img', { name: 'Виконано: 1' })).toBeInTheDocument();
    expect(within(row).queryByLabelText(/Скасовано/)).toBeNull();
  });

  it('минулий день блідне числом і фоном, а лічильники — ні', () => {
    const entries = [entry('IN_PROGRESS', PAST)];
    renderMonth({ '2026-10-14': { total: 1, byLift: {}, entries } });

    const row = screen.getByTestId('month-day-categories');
    expect(row.closest('.opacity-60')).toBeNull();
    const cell = row.closest('button');
    expect(cell).not.toHaveClass('opacity-60');
    expect(within(cell as HTMLElement).getByText('14')).toHaveClass('opacity-60');
  });

  it('день без записів не має рядка лічильників', () => {
    renderMonth({});
    expect(screen.queryByTestId('month-day-categories')).toBeNull();
  });
});
