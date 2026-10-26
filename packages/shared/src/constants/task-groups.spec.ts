/**
 * Групи «Мої задачі» планшета механіка і форматування часу задачі за Києвом.
 *
 * Очікування записані РУКАМИ з дос'є (`docs/objects/task.md`, BR-TASK-005) і з київського
 * календаря (літо EEST +03, зима EET +02), а не виведені з коду модуля.
 */
import { describe, it, expect } from 'vitest';
import {
  TASK_GROUP_LABELS,
  TASK_GROUP_ORDER,
  formatKyivDateTime,
  groupTasksByDue,
  isTaskOverdueAt,
  kyivDayKey,
  taskGroupOf,
  taskTimeMs,
  type TaskGroupInput,
} from './task-groups';

// Літо: 2026-07-15 12:00 за Києвом = 09:00 UTC.
const SUMMER_NOW = new Date('2026-07-15T09:00:00.000Z');
// Зима: 2026-01-15 12:00 за Києвом = 10:00 UTC.
const WINTER_NOW = new Date('2026-01-15T10:00:00.000Z');

const task = (
  status: string,
  dueAt: TaskGroupInput['dueAt'],
  extra: Partial<TaskGroupInput> = {},
) => ({
  status,
  dueAt,
  ...extra,
});

describe('isTaskOverdueAt — BR-TASK-005', () => {
  // guards: BR-TASK-005
  it.each([
    ['NEW', true],
    ['IN_PROGRESS', true],
    ['DONE', false],
    ['CANCELLED', false],
  ])('термін хвилину тому, статус %s → прострочена: %s', (status, expected) => {
    const due = new Date(SUMMER_NOW.getTime() - 60_000).toISOString();
    expect(isTaskOverdueAt({ status, dueAt: due }, SUMMER_NOW)).toBe(expected);
  });

  // guards: BR-TASK-005
  it('термін рівно «зараз» — ще не прострочена (строге dueAt < now, як на сервері)', () => {
    expect(isTaskOverdueAt({ status: 'NEW', dueAt: SUMMER_NOW.getTime() }, SUMMER_NOW)).toBe(false);
    expect(isTaskOverdueAt({ status: 'NEW', dueAt: SUMMER_NOW.getTime() - 1 }, SUMMER_NOW)).toBe(
      true,
    );
  });

  // guards: BR-TASK-005
  it('без терміну чи з невалідним терміном — не прострочена', () => {
    expect(isTaskOverdueAt({ status: 'NEW', dueAt: null }, SUMMER_NOW)).toBe(false);
    expect(isTaskOverdueAt({ status: 'NEW', dueAt: 'не дата' }, SUMMER_NOW)).toBe(false);
  });

  // guards: BR-TASK-005
  it('приймає ISO-рядок (API), мс (WatermelonDB) і Date однаково', () => {
    const iso = '2026-07-15T08:59:00.000Z';
    for (const dueAt of [iso, new Date(iso).getTime(), new Date(iso)]) {
      expect(isTaskOverdueAt({ status: 'IN_PROGRESS', dueAt }, SUMMER_NOW)).toBe(true);
    }
  });
});

describe('taskGroupOf — групи відносно «зараз» за Києвом', () => {
  // guards: BR-TASK-005
  it('відкрита з минулим терміном — «Прострочені», навіть якщо термін сьогодні', () => {
    // 10:00 за Києвом сьогодні, зараз 12:00.
    expect(taskGroupOf(task('NEW', '2026-07-15T07:00:00.000Z'), SUMMER_NOW)).toBe('OVERDUE');
  });

  it('термін пізніше сьогодні — «Сьогодні»; 23:59 за Києвом — ще сьогодні', () => {
    expect(taskGroupOf(task('NEW', '2026-07-15T15:00:00.000Z'), SUMMER_NOW)).toBe('TODAY');
    // 23:59 Київ (літо) = 20:59 UTC того ж дня.
    expect(taskGroupOf(task('IN_PROGRESS', '2026-07-15T20:59:00.000Z'), SUMMER_NOW)).toBe('TODAY');
  });

  it('00:30 наступного дня за Києвом — «Далі», хоча в UTC це ще сьогодні (літо)', () => {
    // 2026-07-16 00:30 Київ = 2026-07-15 21:30 UTC — зріз за UTC дав би «Сьогодні».
    expect(taskGroupOf(task('NEW', '2026-07-15T21:30:00.000Z'), SUMMER_NOW)).toBe('LATER');
  });

  it('межа доби взимку (+02): 23:30 Київ — сьогодні, 00:30 — наступний день', () => {
    // 2026-01-15 23:30 Київ = 21:30 UTC; 2026-01-16 00:30 Київ = 22:30 UTC.
    expect(taskGroupOf(task('NEW', '2026-01-15T21:30:00.000Z'), WINTER_NOW)).toBe('TODAY');
    expect(taskGroupOf(task('NEW', '2026-01-15T22:30:00.000Z'), WINTER_NOW)).toBe('LATER');
  });

  it('без терміну — «Без терміну»; виконана — «Виконані» за будь-якого терміну', () => {
    expect(taskGroupOf(task('NEW', null), SUMMER_NOW)).toBe('NO_DUE');
    expect(taskGroupOf(task('IN_PROGRESS', undefined), SUMMER_NOW)).toBe('NO_DUE');
    expect(taskGroupOf(task('DONE', '2026-07-01T09:00:00.000Z'), SUMMER_NOW)).toBe('DONE');
    expect(taskGroupOf(task('DONE', null), SUMMER_NOW)).toBe('DONE');
  });

  it('скасована й невідомий статус — поза списком (null)', () => {
    expect(taskGroupOf(task('CANCELLED', '2026-07-01T09:00:00.000Z'), SUMMER_NOW)).toBeNull();
    expect(taskGroupOf(task('WHATEVER', null), SUMMER_NOW)).toBeNull();
  });
});

describe('groupTasksByDue — порядок груп і сортування всередині', () => {
  it('групи в порядку Прострочені → Сьогодні → Далі → Без терміну → Виконані, порожніх немає', () => {
    const groups = groupTasksByDue(
      [
        task('DONE', null, { completedAt: '2026-07-14T09:00:00.000Z' }),
        task('NEW', null),
        task('NEW', '2026-07-20T09:00:00.000Z'),
        task('NEW', '2026-07-14T09:00:00.000Z'),
      ],
      SUMMER_NOW,
    );
    expect(groups.map(g => g.key)).toEqual(['OVERDUE', 'LATER', 'NO_DUE', 'DONE']);
    expect(groups.map(g => g.label)).toEqual(['Прострочені', 'Далі', 'Без терміну', 'Виконані']);
  });

  it('за терміном — раніший вище; рівний термін — вищий пріоритет вище', () => {
    const due = '2026-07-15T15:00:00.000Z';
    const groups = groupTasksByDue(
      [
        { ...task('NEW', '2026-07-15T17:00:00.000Z'), id: 'later' },
        { ...task('NEW', due, { priority: 'LOW' }), id: 'low' },
        { ...task('NEW', due, { priority: 'URGENT' }), id: 'urgent' },
      ],
      SUMMER_NOW,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map(t => t.id)).toEqual(['urgent', 'low', 'later']);
  });

  it('«Без терміну» — за пріоритетом; «Виконані» — щойно виконані вище', () => {
    const groups = groupTasksByDue(
      [
        { ...task('NEW', null, { priority: 'NORMAL' }), id: 'normal' },
        { ...task('NEW', null, { priority: 'HIGH' }), id: 'high' },
        { ...task('DONE', null, { completedAt: '2026-07-10T09:00:00.000Z' }), id: 'old' },
        { ...task('DONE', null, { completedAt: '2026-07-15T08:00:00.000Z' }), id: 'fresh' },
      ],
      SUMMER_NOW,
    );
    const byKey = Object.fromEntries(groups.map(g => [g.key, g.items.map(t => t.id)]));
    expect(byKey.NO_DUE).toEqual(['high', 'normal']);
    expect(byKey.DONE).toEqual(['fresh', 'old']);
  });

  it('порожній список — жодної групи; підписи груп покривають увесь порядок', () => {
    expect(groupTasksByDue([], SUMMER_NOW)).toEqual([]);
    expect(TASK_GROUP_ORDER.every(k => TASK_GROUP_LABELS[k].length > 0)).toBe(true);
  });
});

describe('formatKyivDateTime / kyivDayKey — Київ, DD.MM.YYYY HH:mm', () => {
  it.each([
    ['2026-07-15T09:05:00.000Z', '15.07.2026 12:05', '2026-07-15'], // літо +03
    ['2026-01-15T09:05:00.000Z', '15.01.2026 11:05', '2026-01-15'], // зима +02
    ['2026-07-15T21:30:00.000Z', '16.07.2026 00:30', '2026-07-16'], // північ — 00, не 24
    ['2026-12-31T22:00:00.000Z', '01.01.2027 00:00', '2027-01-01'], // новий рік за Києвом
  ])('%s → %s (день %s)', (iso, formatted, day) => {
    expect(formatKyivDateTime(iso)).toBe(formatted);
    expect(formatKyivDateTime(new Date(iso).getTime())).toBe(formatted);
    expect(kyivDayKey(iso)).toBe(day);
  });

  it('порожня чи невалідна мітка — порожній рядок, не «Invalid Date»', () => {
    for (const v of [null, undefined, '', 'abc', Number.NaN]) {
      expect(formatKyivDateTime(v)).toBe('');
      expect(kyivDayKey(v)).toBe('');
      expect(taskTimeMs(v)).toBeNull();
    }
  });
});
