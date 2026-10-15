// Календар, вид «Місяць»: лічильники записів дня за категоріями з іконками (BR-CAL-008, рішення
// власника 2026-10-15): категорії, «прострочено» за кінцем ланцюжка, множина в підказці.

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CalendarMonthView } from '../CalendarMonthView';
import {
  countCategories,
  slotCategory,
  type CategoryInput,
  type MonthEntry,
} from '../calendar-categories';
import { buildMonthSlots } from '../calendar-month';
import type { CalendarSlot, MonthSlots } from '../calendar.types';

const NOW = new Date('2026-10-15T12:00:00+03:00').getTime();
const PAST = NOW - 60_000;
const FUTURE = NOW + 60_000;
const entry = (workOrderStatus: string | null, endMs = FUTURE): CategoryInput => ({
  endMs,
  workOrderStatus,
});

let seq = 0;
/** Запис дня для рендеру: слот + дані категорії (кінець ланцюжка = власний кінець). */
const dayEntry = (workOrderStatus: string | null, endMs = FUTURE): MonthEntry => {
  seq += 1;
  return {
    endMs,
    workOrderStatus,
    slot: {
      id: `s${seq}`,
      startAt: new Date(endMs - 3_600_000).toISOString(),
      endAt: new Date(endMs).toISOString(),
      workOrderStatus,
      ...(workOrderStatus ? { workOrderNumber: `WO-${seq}` } : {}),
    },
  };
};

/** Слот із київським часом `YYYY-MM-DDTHH:mm` (жовтень — UTC+3). */
const slotAt = (
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
        onOpenSlot={() => {}}
        onNewOnDate={() => {}}
      />,
    );

  // guards: BR-CAL-008
  it('показує лише ненульові категорії в порядку: прострочено, в роботі, … виконано', () => {
    const entries = [
      dayEntry('PAID'),
      dayEntry('IN_PROGRESS', PAST),
      dayEntry('IN_PROGRESS', PAST),
      dayEntry('IN_PROGRESS'),
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
    const entries = [dayEntry('IN_PROGRESS', PAST)];
    renderMonth({ '2026-10-14': { total: 1, byLift: {}, entries } });

    const row = screen.getByTestId('month-day-categories');
    expect(row.closest('.opacity-60')).toBeNull();
    const cell = row.closest('[data-testid="month-day"]');
    expect(cell).not.toHaveClass('opacity-60');
    expect(within(cell as HTMLElement).getByText('14')).toHaveClass('opacity-60');
  });

  it('день без записів не має рядка лічильників', () => {
    renderMonth({});
    expect(screen.queryByTestId('month-day-categories')).toBeNull();
  });
});

describe('«Прострочено» за кінцем ланцюжка багатоденного запису (BR-CAL-008)', () => {
  const DAYS = ['2026-10-14', '2026-10-15'];

  // guards: BR-CAL-008
  it('частина вчора + продовження сьогодні, наряд у роботі → обидві частини не прострочені', () => {
    const parent = slotAt('p', '2026-10-14T18:00', '2026-10-14T20:00', 'IN_PROGRESS');
    const child = slotAt('c', '2026-10-15T08:00', '2026-10-15T14:00', 'IN_PROGRESS', 'p');
    const month = buildMonthSlots(
      [
        { d: '2026-10-14', slots: [parent] },
        { d: '2026-10-15', slots: [child] },
      ],
      DAYS,
    );
    const [yesterday] = month['2026-10-14'].entries;
    const [today] = month['2026-10-15'].entries;
    // Вчорашня частина вже скінчилась, але ланцюжок триває до 14:00 сьогодні.
    expect(new Date(parent.endAt).getTime()).toBeLessThan(NOW);
    expect(slotCategory(yesterday, NOW)).toBe('inProgress');
    expect(slotCategory(today, NOW)).toBe('inProgress');
    expect(yesterday.endMs).toBe(new Date(child.endAt).getTime());
  });

  // guards: BR-CAL-008
  it('ланцюжок скінчився (продовження вже в минулому) → прострочені обидві частини', () => {
    const parent = slotAt('p', '2026-10-14T18:00', '2026-10-14T20:00', 'APPROVED');
    const child = slotAt('c', '2026-10-15T08:00', '2026-10-15T11:00', 'APPROVED', 'p');
    const month = buildMonthSlots(
      [
        { d: '2026-10-14', slots: [parent] },
        { d: '2026-10-15', slots: [child] },
      ],
      DAYS,
    );
    expect(slotCategory(month['2026-10-14'].entries[0], NOW)).toBe('overdue');
    expect(slotCategory(month['2026-10-15'].entries[0], NOW)).toBe('overdue');
  });

  // guards: BR-CAL-008
  it('продовження на першому дні наступного місяця враховується, але цей день не показується', () => {
    const late = new Date('2026-11-01T12:00:00+02:00').getTime();
    const parent = slotAt('p', '2026-10-31T18:00', '2026-10-31T20:00', 'IN_PROGRESS');
    const child: CalendarSlot = {
      ...slotAt('c', '2026-10-31T18:00', '2026-10-31T20:00', 'IN_PROGRESS', 'p'),
      startAt: new Date('2026-11-01T08:00:00+02:00').toISOString(),
      endAt: new Date('2026-11-01T14:00:00+02:00').toISOString(),
    };
    const month = buildMonthSlots(
      [
        { d: '2026-10-31', slots: [parent] },
        { d: '2026-11-01', slots: [child] },
      ],
      ['2026-10-31'],
    );
    expect(Object.keys(month)).toEqual(['2026-10-31']);
    // 1 листопада 12:00: жовтнева частина скінчилась, ланцюжок — ні.
    expect(slotCategory(month['2026-10-31'].entries[0], late)).toBe('inProgress');
  });

  it('звичайний одноденний запис — кінець ланцюжка дорівнює власному кінцю', () => {
    const s = slotAt('a', '2026-10-15T09:00', '2026-10-15T10:00', 'DRAFT');
    const month = buildMonthSlots([{ d: '2026-10-15', slots: [s] }], DAYS);
    expect(month['2026-10-15'].entries[0].endMs).toBe(new Date(s.endAt).getTime());
    expect(slotCategory(month['2026-10-15'].entries[0], NOW)).toBe('overdue');
    expect(month['2026-10-15'].total).toBe(1);
  });
});

describe('Підказка клітинки — кількість записів із правильною множиною (BR-CAL-008)', () => {
  // guards: BR-CAL-008
  it.each([
    [1, '1 запис'],
    [2, '2 записи'],
    [5, '5 записів'],
    [21, '21 запис'],
    [22, '22 записи'],
  ])('%i → «%s»', (n, label) => {
    const entries = Array.from({ length: n }, () => dayEntry('APPROVED'));
    render(
      <CalendarMonthView
        yearMonth="2026-10"
        monthSlots={{ '2026-10-20': { total: n, byLift: {}, entries } }}
        monthLoading={false}
        monthError={false}
        nowMs={NOW}
        onDayClick={() => {}}
        onOpenSlot={() => {}}
        onNewOnDate={() => {}}
      />,
    );
    const cell = document.querySelector('[data-date="2026-10-20"]');
    expect(cell).toHaveAttribute('title', label);
  });
});
