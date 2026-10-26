import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CalendarService } from '../calendar/calendar.service';
import { buildSlotStorePrisma, FAKE_ORG_ID } from '../calendar/calendar.spec-fixture';
import { isTaskOverdue } from './tasks.service';
import type { TaskListQueryDto } from './tasks.dto';
import { fakeTask, managerActor, taskHarness } from './tasks.spec-fixture';

/**
 * Аспект «задача в календарі»: відбір за днями (BR-TASK-004 — день за Києвом), прострочення
 * (BR-TASK-005 — обчислюється, не зберігається) і те, що задача НЕ займає календарний час
 * (BR-TASK-007). Відбір виконується над таблицею в пам'яті (`tasks.spec-fixture.ts`).
 */

const query = (over: Partial<TaskListQueryDto>): TaskListQueryDto =>
  ({ page: 1, limit: 200, ...over }) as TaskListQueryDto;

async function titlesFor(rows: Record<string, unknown>[], q: Partial<TaskListQueryDto>) {
  const { service } = taskHarness({ tasks: rows });
  const res = await service.findAll('org-1', managerActor, query(q));
  return res.items.map(i => i.title).sort();
}

describe('Задачі — відбір за днями календаря (BR-TASK-004)', () => {
  // guards: BR-TASK-004
  it('лише термін о 23:30 за Києвом (20:30Z влітку) — задача цього дня, не наступного', async () => {
    const rows = [fakeTask({ title: 'пізно', dueAt: new Date('2026-05-22T20:30:00Z') })];

    expect(await titlesFor(rows, { from: '2026-05-22', to: '2026-05-22' })).toEqual(['пізно']);
    expect(await titlesFor(rows, { from: '2026-05-23', to: '2026-05-23' })).toEqual([]);
  });

  // guards: BR-TASK-004
  it('взимку (+02:00): термін о 00:30 за Києвом (22:30Z попередньої доби UTC) — у своєму дні', async () => {
    const rows = [fakeTask({ title: 'рано', dueAt: new Date('2026-01-14T22:30:00Z') })];

    expect(await titlesFor(rows, { from: '2026-01-15', to: '2026-01-15' })).toEqual(['рано']);
    expect(await titlesFor(rows, { from: '2026-01-14', to: '2026-01-14' })).toEqual([]);
  });

  // guards: BR-TASK-004
  it('початок і термін через кілька днів — задача в кожному дні проміжку, поза ним — ні', async () => {
    const rows = [
      fakeTask({
        title: 'три дні',
        startAt: new Date('2026-05-20T06:00:00Z'),
        dueAt: new Date('2026-05-22T15:00:00Z'),
      }),
    ];

    for (const day of ['2026-05-20', '2026-05-21', '2026-05-22'])
      expect(await titlesFor(rows, { from: day, to: day })).toEqual(['три дні']);
    expect(await titlesFor(rows, { from: '2026-05-19', to: '2026-05-19' })).toEqual([]);
    expect(await titlesFor(rows, { from: '2026-05-23', to: '2026-05-23' })).toEqual([]);
  });

  // guards: BR-TASK-004
  it('місяць одним запитом: точки, проміжки й лише початок; задача без дат не потрапляє', async () => {
    const rows = [
      fakeTask({ title: 'термін', dueAt: new Date('2026-05-31T20:59:00Z') }),
      fakeTask({ title: 'початок', startAt: new Date('2026-05-01T00:00:00Z') }),
      fakeTask({
        title: 'з квітня',
        startAt: new Date('2026-04-28T06:00:00Z'),
        dueAt: new Date('2026-05-02T06:00:00Z'),
      }),
      fakeTask({ title: 'червень', dueAt: new Date('2026-05-31T21:00:00Z') }),
      fakeTask({ title: 'без дат' }),
    ];

    expect(await titlesFor(rows, { from: '2026-05-01', to: '2026-05-31' })).toEqual([
      'з квітня',
      'початок',
      'термін',
    ]);
  });

  // guards: BR-TASK-004
  it('без from/to відбору за датами немає — задачі без дат теж у списку', async () => {
    const rows = [
      fakeTask({ title: 'без дат' }),
      fakeTask({ title: 'з датою', dueAt: new Date() }),
    ];

    expect(await titlesFor(rows, {})).toEqual(['без дат', 'з датою']);
  });
});

describe('Задачі — прострочення (BR-TASK-005)', () => {
  const NOW = new Date('2026-05-22T09:00:00Z');
  const past = new Date('2026-05-22T08:59:00Z');
  const future = new Date('2026-05-22T09:01:00Z');

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Термін у назві кейсу — рядком ISO: `Date` друкувався в поясі машини (GMT+0300 локально,
  // GMT+0000 у CI), і назви кейсів не збігались із baseline.
  // guards: BR-TASK-005
  it.each([
    ['NEW', '2026-05-22T08:59:00Z', true],
    ['IN_PROGRESS', '2026-05-22T08:59:00Z', true],
    ['DONE', '2026-05-22T08:59:00Z', false],
    ['CANCELLED', '2026-05-22T08:59:00Z', false],
    ['NEW', '2026-05-22T09:01:00Z', false],
    ['NEW', null, false],
  ] as const)('статус %s, термін %s → overdue=%s', (status, dueIso, expected) => {
    const dueAt = dueIso === null ? null : new Date(dueIso);
    expect(isTaskOverdue({ status, dueAt }, NOW)).toBe(expected);
  });

  // guards: BR-TASK-005
  it('відповідь несе overdue, фільтр ?overdue=true бере ті самі задачі', async () => {
    const rows = [
      fakeTask({ title: 'прострочена', dueAt: past }),
      fakeTask({ title: 'в роботі прострочена', status: 'IN_PROGRESS', dueAt: past }),
      fakeTask({ title: 'виконана', status: 'DONE', dueAt: past }),
      fakeTask({ title: 'ще є час', dueAt: future }),
    ];
    const { service } = taskHarness({ tasks: rows });

    const all = await service.findAll('org-1', managerActor, query({}));
    const flagged = all.items
      .filter(i => i.overdue)
      .map(i => i.title)
      .sort();
    const filtered = await service.findAll('org-1', managerActor, query({ overdue: 'true' }));

    expect(flagged).toEqual(['в роботі прострочена', 'прострочена']);
    expect(filtered.items.map(i => i.title).sort()).toEqual(flagged);
  });
});

describe('Задача не займає календарний час (BR-TASK-007)', () => {
  const MECHANIC = '33333333-3333-4333-8333-333333333333';
  const LIFT = '22222222-2222-4222-8222-222222222222';
  // 22.05.2026 10:00–11:00 Kyiv = 07:00–08:00Z.
  const startAt = '2026-05-22T07:00:00.000Z';
  const endAt = '2026-05-22T08:00:00.000Z';

  /** Будь-яке звернення календаря до задач — помилка: задачі не мають бути в пробі конфліктів. */
  function calendarWithoutTasks() {
    const prisma = buildSlotStorePrisma([]);
    const guarded = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === 'task') throw new Error('календар звернувся до задач');
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    return { prisma, service: new CalendarService(guarded as never) };
  }

  // guards: BR-TASK-007
  it('час задачі механіка вільний: перевірка конфліктів чиста, запис створюється, задачі не читаються', async () => {
    const { prisma, service } = calendarWithoutTasks();

    const before = await service.checkConflicts(FAKE_ORG_ID, {
      liftId: LIFT,
      employeeId: MECHANIC,
      startAt,
      endAt,
    });
    await service.createSlot(FAKE_ORG_ID, { liftId: LIFT, employeeId: MECHANIC, startAt, endAt });

    expect(before.anyConflict).toBe(false);
    expect(prisma._rows).toHaveLength(1);
  });

  // guards: BR-TASK-007
  it('контроль: справжній запис того самого механіка на той самий час — конфлікт', async () => {
    const { service } = calendarWithoutTasks();
    await service.createSlot(FAKE_ORG_ID, { liftId: LIFT, employeeId: MECHANIC, startAt, endAt });

    const after = await service.checkConflicts(FAKE_ORG_ID, {
      employeeId: MECHANIC,
      startAt,
      endAt,
    });

    expect(after.employeeConflict).toBe(true);
  });
});
