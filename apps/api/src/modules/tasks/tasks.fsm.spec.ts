import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TASK_STATUS_TRANSITIONS, translateError } from '@sto/shared';
import { MECH_A, fakeTask, managerActor, mechA, mechB, taskHarness } from './tasks.spec-fixture';

/**
 * Аспект «статуси задачі» (BR-TASK-003): переходи за `TASK_STATUS_TRANSITIONS`; виконавець рухає
 * лише свою задачу й не скасовує та не повертає виконану в роботу; `DONE` ставить `completedAt`,
 * вихід із `DONE` його знімає; запис — CAS за попереднім статусом.
 */

const STATUSES = ['NEW', 'IN_PROGRESS', 'DONE', 'CANCELLED'] as const;
const NOW = new Date('2026-05-22T09:00:00Z');
const msg = (key: Parameters<typeof translateError>[0]) => translateError(key, 'uk');

const ALL_PAIRS = STATUSES.flatMap(from => STATUSES.map(to => [from, to] as const));
const ALLOWED = ALL_PAIRS.filter(([f, t]) => TASK_STATUS_TRANSITIONS[f].includes(t));
const FORBIDDEN = ALL_PAIRS.filter(([f, t]) => !TASK_STATUS_TRANSITIONS[f].includes(t));

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

describe('Задачі — статуси (BR-TASK-003)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // guards: BR-TASK-003
  it("карта переходів — рівно та, що в дос'є", () => {
    expect(ALLOWED).toEqual([
      ['NEW', 'IN_PROGRESS'],
      ['NEW', 'DONE'],
      ['NEW', 'CANCELLED'],
      ['IN_PROGRESS', 'DONE'],
      ['IN_PROGRESS', 'CANCELLED'],
      ['DONE', 'IN_PROGRESS'],
    ]);
  });

  // guards: BR-TASK-003
  it.each(ALLOWED)('керівник: %s → %s дозволено', async (from, to) => {
    const task = fakeTask({ status: from, completedAt: from === 'DONE' ? NOW : null });
    const { service, tasks } = taskHarness({ tasks: [task] });

    const res = await service.transition('org-1', managerActor, task.id as string, to);

    expect(res.status).toBe(to);
    expect(tasks[0].status).toBe(to);
  });

  // guards: BR-TASK-003
  it.each(FORBIDDEN)('%s → %s поза картою → 400, статус не змінено', async (from, to) => {
    const task = fakeTask({ status: from });
    const { service, tasks } = taskHarness({ tasks: [task] });

    const e = await rejection(service.transition('org-1', managerActor, task.id as string, to));

    expect(e).toBeInstanceOf(BadRequestException);
    expect(tasks[0].status).toBe(from);
  });

  // guards: BR-TASK-003
  it.each([
    ['NEW', 'IN_PROGRESS'],
    ['NEW', 'DONE'],
    ['IN_PROGRESS', 'DONE'],
  ] as const)('виконавець своєї задачі: %s → %s дозволено', async (from, to) => {
    const task = fakeTask({ status: from, assigneeId: MECH_A });
    const { service, tasks } = taskHarness({ tasks: [task] });

    await service.transition('org-1', mechA, task.id as string, to);

    expect(tasks[0].status).toBe(to);
  });

  // guards: BR-TASK-003
  it.each([
    ['NEW', 'CANCELLED'],
    ['IN_PROGRESS', 'CANCELLED'],
    ['DONE', 'IN_PROGRESS'],
  ] as const)(
    'виконавець: %s → %s (лише керування) → 400 transitionForbidden, без запису',
    async (from, to) => {
      const task = fakeTask({ status: from, assigneeId: MECH_A });
      const { service, tasks, prisma } = taskHarness({ tasks: [task] });

      const e = await rejection(service.transition('org-1', mechA, task.id as string, to));

      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as Error).message).toBe(msg('err.task.transitionForbidden'));
      expect(tasks[0].status).toBe(from);
      expect(prisma.task.updateMany).not.toHaveBeenCalled();
    },
  );

  // guards: BR-TASK-003, BR-TASK-002
  it('чужа задача механіка → 404, статус не змінено', async () => {
    const task = fakeTask({ status: 'NEW', assigneeId: MECH_A });
    const { service, tasks } = taskHarness({ tasks: [task] });

    const e = await rejection(service.transition('org-1', mechB, task.id as string, 'IN_PROGRESS'));

    expect(e).toBeInstanceOf(NotFoundException);
    expect(tasks[0].status).toBe('NEW');
  });

  // guards: BR-TASK-003
  it('→ DONE ставить completedAt = зараз; повернення в роботу його знімає', async () => {
    const task = fakeTask({ status: 'IN_PROGRESS' });
    const { service, tasks } = taskHarness({ tasks: [task] });

    const done = await service.transition('org-1', managerActor, task.id as string, 'DONE');
    expect(tasks[0].completedAt).toEqual(NOW);
    expect(done.completedAt).toBe(NOW.toISOString());

    const back = await service.transition('org-1', managerActor, task.id as string, 'IN_PROGRESS');
    expect(tasks[0].completedAt).toBeNull();
    expect(back.completedAt).toBeNull();
  });

  // guards: BR-TASK-003
  it('NEW → IN_PROGRESS не чіпає completedAt; скасування теж', async () => {
    const a = fakeTask({ status: 'NEW' });
    const b = fakeTask({ status: 'IN_PROGRESS' });
    const { service, prisma } = taskHarness({ tasks: [a, b] });

    await service.transition('org-1', managerActor, a.id as string, 'IN_PROGRESS');
    await service.transition('org-1', managerActor, b.id as string, 'CANCELLED');

    for (const [args] of prisma.task.updateMany.mock.calls)
      expect((args as { data: Record<string, unknown> }).data).not.toHaveProperty('completedAt');
  });

  // guards: BR-TASK-003
  it('гонка: статус змінився між читанням і записом → 400, запис не перескакує FSM', async () => {
    const task = fakeTask({ status: 'NEW' });
    const { service, tasks, prisma } = taskHarness({ tasks: [task] });
    // Інший запит устиг скасувати задачу після того, як цей прочитав NEW.
    const realFindFirst = prisma.task.findFirst.getMockImplementation()!;
    prisma.task.findFirst.mockImplementationOnce(async args => {
      const row = await realFindFirst(args);
      tasks[0].status = 'CANCELLED';
      return row;
    });

    const e = await rejection(service.transition('org-1', managerActor, task.id as string, 'DONE'));

    expect(e).toBeInstanceOf(BadRequestException);
    expect(tasks[0].status).toBe('CANCELLED');
    expect(tasks[0].completedAt).toBeNull();
  });
});
