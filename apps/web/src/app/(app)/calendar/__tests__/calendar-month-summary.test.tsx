// Підсумки виду «Місяць» (BR-CAL-013): зведення, підйомники за типами, механіки, стан записів і
// задачі — з уже завантажених записів місяця. Запис через північ лежить у клітинках обох діб,
// але рахується один раз; години — лише записи, що займають пост (без скасованих нарядів).
//
// Mutation-verify: прибрати дедуплікацію за `slot.id` → падає «через північ»; рахувати години
// без `countsAsLoad` → падає «скасований наряд»; брати дні з `Object.keys(monthSlots)` замість
// `days` → падає «довантажене 1-ше число».

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CalendarMonthSummary } from '../CalendarMonthSummary';
import { buildMonthSummary } from '../calendar-month-summary';
import { buildMonthSlots, slotsByKyivDay } from '../calendar-month';
import type { CalendarSlot, Lift } from '../calendar.types';
import type { CalendarTask } from '../calendar-tasks';

const NOW = new Date('2026-10-15T12:00:00+03:00').getTime();
const LIFTS: Lift[] = [
  { id: 'lift-1', name: 'Пост 1' },
  { id: 'lift-2', name: 'Пост 2' },
];
const OCT = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
const NEXT = '2026-11-01';

let seq = 0;
const slot = (start: string, end: string, extra: Partial<CalendarSlot> = {}): CalendarSlot => {
  seq += 1;
  return {
    id: `s${seq}`,
    liftId: 'lift-1',
    employeeId: 'emp-1',
    employeeName: 'Іваненко Іван',
    workOrderId: `wo-${seq}`,
    workOrderNumber: `WO-${seq}`,
    workOrderStatus: 'IN_PROGRESS',
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    ...extra,
  };
};

/** Як `loadMonth`: один запит діапазону → по добах → `buildMonthSlots`. */
const month = (slots: CalendarSlot[]) =>
  buildMonthSlots(slotsByKyivDay(slots, [...OCT, NEXT]), OCT);

const opts = { days: OCT, windowStart: 8, windowEnd: 18, nowMs: NOW };

const task = (status: string, overdue = false): CalendarTask =>
  ({ id: `t-${status}-${overdue}`, title: 'Задача', status, overdue }) as CalendarTask;

describe('buildMonthSummary', () => {
  it('зведення: записи, години на постах, наряди, середнє завантаження', () => {
    const s = buildMonthSummary(
      month([
        slot('2026-10-05T09:00:00+03:00', '2026-10-05T11:00:00+03:00'),
        slot('2026-10-06T09:00:00+03:00', '2026-10-06T12:00:00+03:00', { liftId: 'lift-2' }),
      ]),
      LIFTS,
      [],
      opts,
    );
    expect(s.records).toBe(2);
    expect(s.busyHours).toBe(5);
    expect(s.workOrders).toBe(2);
    // 5 год / (10 год × 31 день × 2 пости) = 0,8% → 1%
    expect(s.avgLoadPct).toBe(1);
  });

  // guards: BR-CAL-013
  it('запис через північ рахується один раз, не в кожній із двох діб', () => {
    const s = buildMonthSummary(
      month([slot('2026-10-20T22:00:00+03:00', '2026-10-21T02:00:00+03:00')]),
      LIFTS,
      [],
      opts,
    );
    expect(s.records).toBe(1);
    expect(s.busyHours).toBe(4);
    expect(s.lifts.find(r => r.liftId === 'lift-1')?.total).toBe(1);
  });

  // guards: BR-CAL-013
  it('довантажене 1-ше число наступного місяця в підсумок не входить', () => {
    const s = buildMonthSummary(
      month([slot('2026-11-01T09:00:00+02:00', '2026-11-01T10:00:00+02:00')]),
      LIFTS,
      [],
      opts,
    );
    expect(s.records).toBe(0);
  });

  // guards: BR-CAL-013
  it('скасований наряд: запис і стан рахуються, години на посту — ні', () => {
    const s = buildMonthSummary(
      month([
        slot('2026-10-05T09:00:00+03:00', '2026-10-05T11:00:00+03:00', {
          workOrderStatus: 'CANCELLED',
        }),
      ]),
      LIFTS,
      [],
      opts,
    );
    expect(s.records).toBe(1);
    expect(s.busyHours).toBe(0);
    expect(s.categories.cancelled).toBe(1);
    expect(s.lifts.find(r => r.liftId === 'lift-1')).toMatchObject({ total: 1, hours: 0 });
  });

  it('типи записів по підйомниках, рядок «без підйомника» — останнім', () => {
    const s = buildMonthSummary(
      month([
        slot('2026-10-05T09:00:00+03:00', '2026-10-05T10:00:00+03:00'),
        slot('2026-10-05T10:00:00+03:00', '2026-10-05T11:00:00+03:00', {
          type: 'BREAK',
          workOrderId: null,
          workOrderStatus: null,
        }),
        slot('2026-10-06T09:00:00+03:00', '2026-10-06T10:00:00+03:00', { liftId: null }),
      ]),
      LIFTS,
      [],
      opts,
    );
    expect(s.lifts.map(r => r.liftId)).toEqual(['lift-1', 'lift-2', null]);
    expect(s.lifts[0].byType).toMatchObject({ WORK: 1, BREAK: 1, MAINTENANCE: 0, MEETING: 0 });
    expect(s.lifts[2]).toMatchObject({ total: 1, loadPct: null });
    expect(s.liftsTotal).toMatchObject({ total: 3, byType: { WORK: 2, BREAK: 1 } });
  });

  it('механіки: записи, години, наряди; «без механіка» — останнім', () => {
    const s = buildMonthSummary(
      month([
        slot('2026-10-05T09:00:00+03:00', '2026-10-05T10:00:00+03:00', { workOrderId: 'wo-a' }),
        slot('2026-10-06T09:00:00+03:00', '2026-10-06T12:00:00+03:00', { workOrderId: 'wo-a' }),
        slot('2026-10-07T09:00:00+03:00', '2026-10-07T10:00:00+03:00', {
          employeeId: null,
          employeeName: null,
        }),
      ]),
      LIFTS,
      [],
      opts,
    );
    expect(s.mechanics).toEqual([
      { employeeId: 'emp-1', name: 'Іваненко Іван', records: 2, hours: 4, workOrders: 1 },
      expect.objectContaining({ employeeId: null, records: 1 }),
    ]);
  });

  it('задачі місяця — за тоном: відкриті, прострочені, виконані, скасовані', () => {
    const s = buildMonthSummary(
      {},
      LIFTS,
      [task('NEW'), task('IN_PROGRESS', true), task('DONE'), task('CANCELLED')],
      opts,
    );
    expect(s.tasks).toEqual({ open: 1, overdue: 1, done: 1, cancelled: 1 });
  });
});

describe('CalendarMonthSummary', () => {
  const props = {
    yearMonth: '2026-10',
    lifts: LIFTS,
    windowStart: 8,
    windowEnd: 18,
    nowMs: NOW,
  };

  it('таблиця підйомників із рядком «Разом» і зведені цифри', () => {
    render(
      <CalendarMonthSummary
        {...props}
        monthSlots={month([slot('2026-10-05T09:00:00+03:00', '2026-10-05T11:00:00+03:00')])}
        tasks={[task('NEW')]}
      />,
    );
    expect(within(screen.getByTestId('month-summary-records')).getByText('1')).toBeInTheDocument();
    const lifts = screen.getByTestId('month-summary-lifts');
    expect(within(lifts).getByText('Пост 1')).toBeInTheDocument();
    expect(within(lifts.querySelector('tfoot')!).getByText('Разом')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('month-summary-mechanics')).getByText('Іваненко Іван'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('month-summary-tasks')).getByText('Відкриті'),
    ).toBeInTheDocument();
  });

  it('підйомники без записів — не рядками нулів, а одним «ще N»', () => {
    render(
      <CalendarMonthSummary
        {...props}
        monthSlots={month([slot('2026-10-05T09:00:00+03:00', '2026-10-05T11:00:00+03:00')])}
        tasks={[]}
      />,
    );
    const lifts = screen.getByTestId('month-summary-lifts');
    expect(within(lifts).getByText('Пост 1')).toBeInTheDocument();
    expect(within(lifts).queryByText('Пост 2')).toBeNull();
    expect(screen.getByTestId('month-summary-idle-lifts')).toHaveTextContent(
      'Ще 1 підйомник без записів за місяць',
    );
  });

  it('порожній місяць — один рядок замість порожніх таблиць', () => {
    render(<CalendarMonthSummary {...props} monthSlots={{}} tasks={[]} />);
    expect(screen.getByTestId('month-summary-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('month-summary-lifts')).toBeNull();
  });
});
