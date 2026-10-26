import { describe, it, expect } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { CommentsService } from '../comments/comments.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { TaskListQueryDto } from './tasks.dto';
import {
  FIRED,
  FOREIGN_EMP,
  MECH_A,
  MECH_B,
  ON_LEAVE,
  buildTaskStore,
  fakeTask,
  managerActor,
  mechA,
  mechB,
  taskHarness,
} from './tasks.spec-fixture';

/**
 * Аспект «хто що бачить і кому ставлять»: виконавець — активний працівник своєї організації
 * (BR-TASK-001), видимість у `where` кожного читання (BR-TASK-002), коментарі задачі — тим, хто її
 * бачить (BR-TASK-008). Ролі на маршрутах (403) — `tasks.contract.spec.ts`.
 */

const ORG = 'org-1';
const msg = (key: Parameters<typeof translateError>[0]) => translateError(key, 'uk');
const query = (over: Partial<TaskListQueryDto> = {}) =>
  ({ page: 1, limit: 50, ...over }) as TaskListQueryDto;
const form = (over: Record<string, unknown> = {}) => ({
  title: 'Замінити лампу',
  assigneeId: MECH_A,
  priority: 'NORMAL' as const,
  startAt: undefined,
  dueAt: undefined,
  ...over,
});

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

function twoMechanics() {
  const a = fakeTask({ title: 'для A', assigneeId: MECH_A });
  const b = fakeTask({ title: 'для B', assigneeId: MECH_B });
  return { a, b, ...taskHarness({ tasks: [a, b] }) };
}

describe('Задачі — виконавець (BR-TASK-001)', () => {
  // guards: BR-TASK-001
  it('активний працівник своєї організації → задачу поставлено, автор — з токена', async () => {
    const { service, tasks } = taskHarness();

    const res = await service.create(ORG, managerActor, form());

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      assigneeId: MECH_A,
      createdById: managerActor.id,
      orgId: ORG,
    });
    expect(res.assigneeName).toBe('Тест Андрій');
  });

  // guards: BR-TASK-001
  it.each([
    ['звільнений', FIRED, 'err.task.assigneeNotFound'],
    ['з іншої організації', FOREIGN_EMP, 'err.task.assigneeNotFound'],
    ['невідомий', '11111111-1111-4111-8111-0000000000ff', 'err.task.assigneeNotFound'],
    ['у відпустці', ON_LEAVE, 'err.task.assigneeOnLeave'],
  ] as const)('виконавець %s → 400, задачу не створено', async (_why, assigneeId, key) => {
    const { service, tasks } = taskHarness();

    const e = await rejection(service.create(ORG, managerActor, form({ assigneeId })));

    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toBe(msg(key));
    expect(tasks).toHaveLength(0);
  });

  // guards: BR-TASK-001
  it('переназначення на працівника у відпустці → 400; той самий виконавець у відпустці не заважає правці', async () => {
    const task = fakeTask({ assigneeId: ON_LEAVE });
    const other = fakeTask({ assigneeId: MECH_A });
    const { service, tasks } = taskHarness({ tasks: [task, other] });

    await service.update(
      ORG,
      managerActor,
      task.id as string,
      form({ assigneeId: ON_LEAVE, title: 'нова' }),
    );
    const e = await rejection(
      service.update(ORG, managerActor, other.id as string, form({ assigneeId: ON_LEAVE })),
    );

    expect(tasks[0].title).toBe('нова');
    expect((e as Error).message).toBe(msg('err.task.assigneeOnLeave'));
    expect(tasks[1].assigneeId).toBe(MECH_A);
  });
});

describe('Задачі — видимість (BR-TASK-002)', () => {
  // guards: BR-TASK-002
  it('механік у списку бачить лише свої задачі', async () => {
    const { service } = twoMechanics();

    const res = await service.findAll(ORG, mechA, query());

    expect(res.items.map(i => i.title)).toEqual(['для A']);
    expect(res.total).toBe(1);
  });

  // guards: BR-TASK-002
  it('фільтр «виконавець = інший» не відкриває механіку чужі задачі', async () => {
    const { service } = twoMechanics();

    const res = await service.findAll(ORG, mechA, query({ assigneeId: MECH_B }));

    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
  });

  // guards: BR-TASK-002
  it.each(['OWNER', 'ADMIN', 'RECEPTIONIST'])('роль керування %s бачить усі задачі', async role => {
    const { service } = twoMechanics();

    const res = await service.findAll(ORG, { id: 'mgr', role }, query());

    expect(res.items.map(i => i.title).sort()).toEqual(['для A', 'для B']);
  });

  // guards: BR-TASK-002
  it.each(['STOREKEEPER', 'ACCOUNTANT'])(
    'роль %s (не керування) — як виконавець: лише свої',
    async role => {
      const { service } = twoMechanics();

      const res = await service.findAll(ORG, { id: MECH_B, role }, query());

      expect(res.items.map(i => i.title)).toEqual(['для B']);
    },
  );

  // guards: BR-TASK-002
  it('«Мої задачі» (?mine=1) у керівника — лише ті, де він виконавець', async () => {
    const { service } = twoMechanics();

    const res = await service.findAll(ORG, { id: MECH_B, role: 'ADMIN' }, query({ mine: '1' }));

    expect(res.items.map(i => i.title)).toEqual(['для B']);
  });

  // guards: BR-TASK-002
  it('картка чужої задачі механіку → 404; своя — 200', async () => {
    const { service, a, b } = twoMechanics();

    expect((await service.findOne(ORG, mechA, a.id as string)).title).toBe('для A');
    const e = await rejection(service.findOne(ORG, mechA, b.id as string));

    expect(e).toBeInstanceOf(NotFoundException);
    expect((e as Error).message).toBe(msg('err.task.notFound'));
  });

  // guards: BR-TASK-002
  it('видалена задача і задача іншої організації — 404 навіть керівнику', async () => {
    const del = fakeTask({ deletedAt: new Date() });
    const foreign = fakeTask({ orgId: 'org-2' });
    const { service } = taskHarness({ tasks: [del, foreign] });

    expect(await rejection(service.findOne(ORG, managerActor, del.id as string))).toBeInstanceOf(
      NotFoundException,
    );
    expect(
      await rejection(service.findOne(ORG, managerActor, foreign.id as string)),
    ).toBeInstanceOf(NotFoundException);
  });
});

describe('Задачі — коментарі (BR-TASK-008)', () => {
  function comments(tasks: Record<string, unknown>[]) {
    const store = buildTaskStore({ tasks });
    const created: Record<string, unknown>[] = [];
    const prisma = {
      ...store,
      comment: {
        findMany: () => Promise.resolve([]),
        count: () => Promise.resolve(0),
        create: ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return Promise.resolve({
            id: 'c-1',
            createdAt: new Date(),
            author: { firstName: 'А', lastName: 'Б' },
            ...data,
          });
        },
      },
    };
    return { svc: new CommentsService(prisma as unknown as PrismaService), created };
  }
  const body = (entityId: string) => ({ entityType: 'Task' as const, entityId, body: 'Зроблено' });

  // guards: BR-TASK-008
  it('виконавець коментує свою задачу; керівник — будь-яку', async () => {
    const task = fakeTask({ assigneeId: MECH_A });
    const { svc, created } = comments([task]);

    await svc.create(ORG, mechA, body(task.id as string));
    await svc.create(ORG, managerActor, body(task.id as string));

    expect(created.map(c => c.authorId)).toEqual([MECH_A, managerActor.id]);
    expect(created[0]).toMatchObject({ entityType: 'Task', orgId: ORG });
  });

  // guards: BR-TASK-008, BR-TASK-002
  it('механік не пише й не читає коментарі чужої задачі → 404', async () => {
    const task = fakeTask({ assigneeId: MECH_A });
    const { svc, created } = comments([task]);

    const write = await rejection(svc.create(ORG, mechB, body(task.id as string)));
    const read = await rejection(svc.findAll(ORG, 'Task', task.id as string, mechB));

    expect(write).toBeInstanceOf(NotFoundException);
    expect(read).toBeInstanceOf(NotFoundException);
    expect(created).toHaveLength(0);
  });

  // guards: BR-TASK-008
  it('свої коментарі виконавець читає', async () => {
    const task = fakeTask({ assigneeId: MECH_A });
    const { svc } = comments([task]);

    await expect(svc.findAll(ORG, 'Task', task.id as string, mechA)).resolves.toEqual({
      items: [],
      total: 0,
    });
  });
});
