/**
 * Дія «створити задачу» (docs/objects/automation.md, BR-AUT-030…032): автор «Автоматизація»,
 * прив'язка до документа й правила, виконавець за стратегією, термін від події, без дубля
 * відкритої задачі.
 */
import { describe, it, expect, vi } from 'vitest';
import { TASK_DESCRIPTION_MAX, TASK_TITLE_MAX } from '@sto/shared';
import type { PrismaService } from '../../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import {
  ORG as TASK_ORG,
  buildTaskStore,
  fakeTask,
  managerActor,
} from '../tasks/tasks.spec-fixture';
import {
  MECH_1,
  MECH_2,
  ON_LEAVE,
  RECEPTION,
  automationHarness,
  fakeCtx,
  fakeEvent,
  fakeRule,
} from './automation.spec-fixture';

const taskAction = (over: Record<string, unknown> = {}) => ({
  type: 'create_task',
  title: 'Підготувати пост: {{documentNumber}}',
  description: 'Авто {{vehicle}}',
  assignee: 'responsible',
  dueInHours: 2,
  priority: 'HIGH',
  ...over,
});

async function fire(
  action: Record<string, unknown>,
  opts: {
    ctx?: ReturnType<typeof fakeCtx>;
    tasks?: Record<string, unknown>[];
    actorId?: string;
  } = {},
) {
  const rule = fakeRule({ toStatuses: ['APPROVED'], actions: [action] });
  const h = automationHarness({ rules: [rule], ctx: opts.ctx, tasks: opts.tasks });
  await h.engine.handle(
    fakeEvent({ toStatus: 'APPROVED', ...(opts.actorId && { actorId: opts.actorId }) }),
  );
  return { h, rule, tasks: h.tables.task.rows, run: h.runs[0] };
}

describe('Дія «створити задачу»', () => {
  // guards: BR-AUT-030, BR-AUT-031
  it('задача: автор «Автоматизація» (createdById null), правило, документ, наряд, термін = подія + N год', async () => {
    const { tasks, rule, h, run } = await fire(taskAction());
    expect(tasks).toEqual([
      expect.objectContaining({
        orgId: 'org-a',
        title: 'Підготувати пост: НРД-7',
        description: 'Авто Toyota Camry (AA1234BB)',
        assigneeId: MECH_1,
        priority: 'HIGH',
        createdById: null,
        automationRuleId: rule.id,
        entityType: 'WORK_ORDER',
        entityId: 'doc-wo-1',
        workOrderId: 'doc-wo-1',
        vehicleId: 'veh-1',
        dueAt: new Date('2026-10-29T12:00:00.000Z'),
      }),
    ]);
    expect(run?.actionResults).toEqual([
      expect.objectContaining({ status: 'DONE', taskId: tasks[0]!.id }),
    ]);
    // Подія «створено» задачі — система (без ініціатора), у тій самій транзакції.
    expect(h.tables.domainEvent.rows).toEqual([
      expect.objectContaining({
        documentType: 'TASK',
        kind: 'CREATED',
        documentId: tasks[0]!.id,
        actorId: null,
      }),
    ]);
  });

  // guards: BR-AUT-030
  it('назва й опис задачі з підставленими змінними не перевищують ліміт задачі (інакше її не зберегти з форми)', async () => {
    const longName = 'Т'.repeat(TASK_TITLE_MAX);
    const { tasks } = await fire(
      taskAction({ title: 'Клієнт {{clientName}}', description: '{{clientName}} '.repeat(10) }),
      {
        ctx: fakeCtx({
          vars: { ...fakeCtx().vars, clientName: longName },
        }),
      },
    );
    const task = tasks[0]!;
    expect((task.title as string).length).toBeLessThanOrEqual(TASK_TITLE_MAX);
    expect(task.title as string).toMatch(/^Клієнт Т+…$/);
    expect((task.description as string).length).toBeLessThanOrEqual(TASK_DESCRIPTION_MAX);
    // Контроль: короткий текст не чіпається.
    const short = await fire(taskAction());
    expect(short.tasks[0]?.title).toBe('Підготувати пост: НРД-7');
  });

  // guards: BR-AUT-030
  it('виконавець отримує сповіщення в системі; якщо він сам ініціатор — ні', async () => {
    const notified = await fire(taskAction());
    expect(notified.h.tables.employeeNotification.rows).toEqual([
      expect.objectContaining({
        employeeId: MECH_1,
        documentType: 'TASK',
        documentId: notified.tasks[0]!.id,
      }),
    ]);
    const self = await fire(taskAction(), { actorId: MECH_1 });
    expect(self.tasks).toHaveLength(1);
    expect(self.h.tables.employeeNotification.rows).toHaveLength(0);
  });

  // guards: BR-AUT-030
  it('конкретний виконавець; відповідальний у відпустці — запасний; нікого — пропуск «немає виконавця»', async () => {
    const fixed = await fire(taskAction({ assignee: { employeeId: RECEPTION } }));
    expect(fixed.tasks[0]?.assigneeId).toBe(RECEPTION);

    const fallback = await fire(taskAction({ fallbackEmployeeId: MECH_2 }), {
      ctx: fakeCtx({ responsibleIds: [ON_LEAVE] }),
    });
    expect(fallback.tasks[0]?.assigneeId).toBe(MECH_2);

    const nobody = await fire(taskAction(), { ctx: fakeCtx({ responsibleIds: [] }) });
    expect(nobody.tasks).toHaveLength(0);
    expect(nobody.run?.actionResults).toEqual([
      expect.objectContaining({ status: 'SKIPPED', reason: 'NO_ASSIGNEE' }),
    ]);
  });

  // guards: BR-AUT-032
  it('відкрита задача того самого правила для документа вже є — другої не створює; виконана — створює', async () => {
    const rule = fakeRule({ toStatuses: ['APPROVED'], actions: [taskAction()] });
    const open = {
      id: 't-open',
      orgId: 'org-a',
      automationRuleId: rule.id,
      entityType: 'WORK_ORDER',
      entityId: 'doc-wo-1',
      status: 'IN_PROGRESS',
      deletedAt: null,
    };
    const h = automationHarness({ rules: [rule], tasks: [open] });
    await h.engine.handle(fakeEvent({ toStatus: 'APPROVED' }));
    expect(h.tables.task.rows).toHaveLength(1);
    expect(h.runs[0]?.actionResults).toEqual([
      expect.objectContaining({ status: 'SKIPPED', reason: 'TASK_EXISTS', taskId: 't-open' }),
    ]);

    open.status = 'DONE';
    await h.engine.handle(fakeEvent({ toStatus: 'APPROVED' }));
    expect(h.tables.task.rows).toHaveLength(2);
  });

  // guards: BR-AUT-032
  it('задача іншого правила чи іншого документа дублем не вважається', async () => {
    const others = [
      {
        id: 't1',
        orgId: 'org-a',
        automationRuleId: 'rule-other',
        entityType: 'WORK_ORDER',
        entityId: 'doc-wo-1',
        status: 'NEW',
        deletedAt: null,
      },
      {
        id: 't2',
        orgId: 'org-a',
        automationRuleId: null,
        entityType: 'WORK_ORDER',
        entityId: 'doc-wo-2',
        status: 'NEW',
        deletedAt: null,
      },
    ];
    const { tasks } = await fire(taskAction(), { tasks: others });
    expect(tasks).toHaveLength(3);
  });
});

describe('Картка задачі від правила', () => {
  // guards: BR-AUT-031
  it('автор — «Автоматизація», видно правило, що створило задачу; ручна задача — працівник', async () => {
    const auto = fakeTask({
      createdById: null,
      automationRuleId: 'rule-x',
      entityType: 'WORK_ORDER',
      entityId: 'wo-9',
    });
    const manual = fakeTask({ automationRuleId: null });
    const store = buildTaskStore({ tasks: [auto, manual] });
    const ruleFindMany = vi
      .fn()
      .mockResolvedValue([{ id: 'rule-x', name: 'Затверджено → механіку' }]);
    const prisma = {
      ...store,
      automationRule: { findMany: ruleFindMany },
    } as unknown as PrismaService;
    const svc = new TasksService(prisma);

    const dto = await svc.findOne(TASK_ORG, managerActor, auto.id as string);
    expect(dto).toMatchObject({
      createdById: null,
      createdByName: 'Автоматизація',
      automationRuleId: 'rule-x',
      automationRuleName: 'Затверджено → механіку',
      entityType: 'WORK_ORDER',
      entityId: 'wo-9',
    });
    expect(ruleFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: TASK_ORG, id: { in: ['rule-x'] } } }),
    );

    ruleFindMany.mockClear();
    const own = await svc.findOne(TASK_ORG, managerActor, manual.id as string);
    expect(own.createdByName).not.toBe('Автоматизація');
    expect(own.automationRuleName).toBeNull();
    expect(ruleFindMany).not.toHaveBeenCalled();
  });
});
