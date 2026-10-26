// Задачі співробітникам у календарі (docs/objects/task.md): дні задачі за Києвом (BR-TASK-004),
// блок смуги «Задачі» дня, доріжки, колір за станом (BR-TASK-005) і картки «Місяця», що
// рахуються в «ще N» разом із записами, але не є записами (BR-TASK-007).

import { describe, expect, it } from 'vitest';
import {
  layoutTaskLanes,
  monthCellCards,
  taskDayBlock,
  taskDays,
  taskTone,
  tasksByDay,
  type CalendarTask,
} from '../calendar-tasks';
import type { MonthEntry } from '../calendar-categories';
import type { CalendarSlot } from '../calendar.types';

let seq = 0;
const task = (over: Partial<CalendarTask>): CalendarTask => {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: `Задача ${seq}`,
    status: 'NEW',
    priority: 'NORMAL',
    assigneeId: 'm-1',
    assigneeName: 'Коваль Іван',
    startAt: null,
    dueAt: null,
    overdue: false,
    workOrderNumber: null,
    ...over,
  };
};
const entry = (startAt: string): MonthEntry => ({
  slot: { id: `s-${startAt}`, startAt, endAt: startAt } as CalendarSlot,
  endMs: new Date(startAt).getTime(),
  workOrderStatus: null,
});

describe('дні задачі за Києвом (BR-TASK-004)', () => {
  // guards: BR-TASK-004
  it('літо (+03:00): термін о 23:30 за Києвом (20:30Z) — цей день, не наступний', () => {
    expect(taskDays(task({ dueAt: '2026-05-22T20:30:00.000Z' }))).toEqual(['2026-05-22']);
  });

  // guards: BR-TASK-004
  it('зима (+02:00): термін о 00:30 за Києвом (22:30Z попередньої доби UTC) — свій день', () => {
    expect(taskDays(task({ dueAt: '2026-01-14T22:30:00.000Z' }))).toEqual(['2026-01-15']);
  });

  // guards: BR-TASK-004
  it('проміжок через перехід на літній час — кожен день по разу; без дат — жодного дня', () => {
    expect(
      taskDays(task({ startAt: '2026-03-28T08:00:00.000Z', dueAt: '2026-03-30T08:00:00.000Z' })),
    ).toEqual(['2026-03-28', '2026-03-29', '2026-03-30']);
    expect(taskDays(task({}))).toEqual([]);
  });

  // guards: BR-TASK-004
  it('tasksByDay розкладає задачу по всіх її днях, лише видимих', () => {
    const t = task({ startAt: '2026-05-30T08:00:00.000Z', dueAt: '2026-06-01T08:00:00.000Z' });
    const byDay = tasksByDay([t], new Set(['2026-05-30', '2026-05-31']));
    expect(Object.keys(byDay).sort()).toEqual(['2026-05-30', '2026-05-31']);
  });
});

describe('блок смуги «Задачі» дня', () => {
  // 22.05.2026 (+03:00): вікно 08–18.
  it('проміжок у межах дня — години за Києвом', () => {
    const b = taskDayBlock(
      task({ startAt: '2026-05-22T07:00:00.000Z', dueAt: '2026-05-22T09:30:00.000Z' }),
      '2026-05-22',
      8,
      18,
    );
    expect(b).toEqual({ startH: 10, endH: 12.5, point: false });
  });

  it('лише термін — позначка (point) у момент терміну', () => {
    const b = taskDayBlock(task({ dueAt: '2026-05-22T12:00:00.000Z' }), '2026-05-22', 8, 18);
    expect(b).toEqual({ startH: 15, endH: 15, point: true });
  });

  it('задача з учора на завтра — від відкриття до закриття; поза днем — null', () => {
    const t = task({ startAt: '2026-05-21T10:00:00.000Z', dueAt: '2026-05-23T10:00:00.000Z' });
    expect(taskDayBlock(t, '2026-05-22', 8, 18)).toEqual({ startH: 8, endH: 18, point: false });
    expect(taskDayBlock(t, '2026-05-24', 8, 18)).toBeNull();
  });

  it('доріжки: задачі, що перетинаються, — на різних; наступна після кінця — на першій', () => {
    const { lanes, count } = layoutTaskLanes(
      [
        { id: 'a', startH: 9, endH: 11 },
        { id: 'b', startH: 10, endH: 10 },
        { id: 'c', startH: 11, endH: 12 },
      ],
      0.5,
    );
    expect(count).toBe(2);
    expect([lanes.get('a'), lanes.get('b'), lanes.get('c')]).toEqual([0, 1, 0]);
  });
});

describe('колір задачі за станом (BR-TASK-005)', () => {
  // guards: BR-TASK-005
  it.each([
    ['NEW', true, 'overdue'],
    ['IN_PROGRESS', false, 'open'],
    ['DONE', false, 'done'],
    ['CANCELLED', false, 'cancelled'],
  ] as const)('%s, overdue=%s → %s', (status, overdue, tone) => {
    expect(taskTone({ status, overdue })).toBe(tone);
  });
});

describe('картки клітинки «Місяця» (BR-TASK-007)', () => {
  // guards: BR-TASK-007
  it('записи й задачі — разом за часом, не більше трьох; задачі рахуються в «ще N»', () => {
    const day = '2026-05-22';
    const { cards, more } = monthCellCards(
      [entry('2026-05-22T06:00:00.000Z'), entry('2026-05-22T09:00:00.000Z')],
      [
        task({ title: 'рання', dueAt: '2026-05-22T05:00:00.000Z' }),
        task({ title: 'пізня', dueAt: '2026-05-22T12:00:00.000Z' }),
      ],
      day,
    );
    expect(cards.map(c => (c.kind === 'task' ? c.task.title : c.entry.slot.startAt))).toEqual([
      'рання',
      '2026-05-22T06:00:00.000Z',
      '2026-05-22T09:00:00.000Z',
    ]);
    expect(more).toBe(1);
  });

  // guards: BR-TASK-007
  it('продовження задачі з учора — першою в дні (без часу початку)', () => {
    const { cards } = monthCellCards(
      [entry('2026-05-22T05:00:00.000Z')],
      [
        task({
          title: 'з учора',
          startAt: '2026-05-21T10:00:00.000Z',
          dueAt: '2026-05-23T10:00:00.000Z',
        }),
      ],
      '2026-05-22',
    );
    expect(cards[0]).toMatchObject({ kind: 'task' });
  });
});
