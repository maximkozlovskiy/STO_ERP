// Вид «Місяць»: колір завантаженості клітинки не рахує записів скасованих і видалених нарядів —
// так само, як «N год з M» у «Дні» (BR-CAL-008, рішення власника 2026-10-16). Підказка й
// лічильники рахують усі записи дня. Записи видаленого наряду календар не показує ніде
// (BR-CAL-011): `liveSlots` відкидає їх одразу після відповіді API.

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CalendarMonthView } from '../CalendarMonthView';
import { buildMonthSlots, countsAsLoad, liveSlots } from '../calendar-month';
import type { CalendarSlot, MonthSlots } from '../calendar.types';

const NOW = new Date('2026-10-15T12:00:00+03:00').getTime();

let seq = 0;
const slot = (
  day: string,
  workOrderStatus: string | null,
  extra: Partial<CalendarSlot> = {},
): CalendarSlot => {
  seq += 1;
  return {
    id: `s${seq}`,
    liftId: 'lift-1',
    startAt: new Date(`${day}T10:00:00+03:00`).toISOString(),
    endAt: new Date(`${day}T11:00:00+03:00`).toISOString(),
    workOrderStatus,
    ...(workOrderStatus ? { workOrderNumber: `WO-${seq}` } : {}),
    ...extra,
  };
};

function monthOf(byDay: Record<string, CalendarSlot[]>): MonthSlots {
  const days = Object.keys(byDay);
  return buildMonthSlots(
    days.map(d => ({ d, slots: byDay[d] })),
    days,
  );
}

function renderMonth(monthSlots: MonthSlots) {
  render(
    <CalendarMonthView
      yearMonth="2026-10"
      monthSlots={monthSlots}
      monthLoading={false}
      monthError={false}
      nowMs={NOW}
      onDayClick={() => {}}
      onOpenSlot={() => {}}
      onNewOnDate={() => {}}
    />,
  );
}

const cell = (date: string) => document.querySelector<HTMLElement>(`[data-date="${date}"]`)!;
const bg = (date: string) => cell(date).style.backgroundColor;

describe('Колір завантаженості клітинки «Місяця» (BR-CAL-008)', () => {
  // guards: BR-CAL-008
  it('busy рахує записи без скасованих і видалених нарядів; total — усі записи дня', () => {
    const month = monthOf({
      '2026-10-20': [
        slot('2026-10-20', 'IN_PROGRESS'),
        slot('2026-10-20', null),
        slot('2026-10-20', 'CANCELLED'),
        slot('2026-10-20', 'APPROVED', { workOrderDeleted: true }),
      ],
    });
    expect(month['2026-10-20']).toMatchObject({ total: 4, busy: 2 });
  });

  // guards: BR-CAL-008
  it('день лише зі скасованими записами — без кольору, але з підказкою й лічильником', () => {
    renderMonth(
      monthOf({
        '2026-10-20': [slot('2026-10-20', 'CANCELLED'), slot('2026-10-20', 'CANCELLED')],
        '2026-10-21': [slot('2026-10-21', 'APPROVED')],
      }),
    );
    expect(bg('2026-10-20')).toBe('');
    expect(cell('2026-10-20')).toHaveAttribute('title', '2 записи');
    expect(bg('2026-10-21')).not.toBe('');
  });

  // guards: BR-CAL-008
  it('скасовані не роблять день темнішим: 2 активні + 5 скасованих = колір 2 активних', () => {
    const active = (d: string) => [slot(d, 'APPROVED'), slot(d, 'IN_PROGRESS')];
    renderMonth(
      monthOf({
        '2026-10-20': [
          ...active('2026-10-20'),
          ...Array.from({ length: 5 }, () => slot('2026-10-20', 'CANCELLED')),
        ],
        '2026-10-21': active('2026-10-21'),
      }),
    );
    expect(bg('2026-10-20')).toBe(bg('2026-10-21'));
    expect(bg('2026-10-20')).not.toBe('');
  });

  it.each([
    ['IN_PROGRESS', false, true],
    [null, false, true],
    ['CANCELLED', false, false],
    ['APPROVED', true, false],
  ] as const)('countsAsLoad: наряд %s, видалено %s → %s', (status, deleted, expected) => {
    expect(countsAsLoad({ workOrderStatus: status, workOrderDeleted: deleted })).toBe(expected);
  });
});

describe('Записи видаленого наряду не показуються (BR-CAL-011)', () => {
  // guards: BR-CAL-011
  it('liveSlots відкидає запис із позначкою workOrderDeleted, решту лишає в порядку', () => {
    const a = slot('2026-10-20', 'APPROVED');
    const gone = slot('2026-10-20', 'DRAFT', { workOrderDeleted: true });
    const b = slot('2026-10-20', null);
    expect(liveSlots([a, gone, b]).map(s => s.id)).toEqual([a.id, b.id]);
  });
});
