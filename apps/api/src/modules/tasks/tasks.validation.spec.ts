import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { taskFormSchema, translateError } from '@sto/shared';
import {
  CP_ID,
  MECH_A,
  VEHICLE_ID,
  WO_DELETED,
  WO_FOREIGN,
  WO_ID,
  fakeTask,
  managerActor,
  taskHarness,
} from './tasks.spec-fixture';

/**
 * Аспект «поля задачі»: початок не пізніше терміну (BR-TASK-004) і прив'язки — лише живі записи
 * своєї організації (BR-TASK-006). Поля приходять уже розібраними `taskFormSchema` (як у
 * контролері) — схема тут теж перевіряється, бо саме вона стоїть першою на вході.
 */

const ORG = 'org-1';
const msg = (key: Parameters<typeof translateError>[0]) => translateError(key, 'uk');
const parse = (over: Record<string, unknown> = {}) =>
  taskFormSchema.parse({ title: 'Перевірити гальма', assigneeId: MECH_A, ...over });

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

describe('Задачі — початок і термін (BR-TASK-004)', () => {
  const start = '2026-05-22T10:00:00.000Z';
  const due = '2026-05-22T09:59:00.000Z';

  // guards: BR-TASK-004
  it('схема форми: термін раніше початку → помилка на полі dueAt', () => {
    const res = taskFormSchema.safeParse({
      title: 'x',
      assigneeId: MECH_A,
      startAt: start,
      dueAt: due,
    });

    expect(res.success).toBe(false);
    expect(res.error?.issues[0]).toMatchObject({
      path: ['dueAt'],
      message: 'v.task.dueBeforeStart',
    });
  });

  // guards: BR-TASK-004
  it('сервіс теж відхиляє термін раніше початку (вхід в обхід схеми) → 400, задачі немає', async () => {
    const { service, tasks } = taskHarness();

    const e = await rejection(
      service.create(ORG, managerActor, { ...parse(), startAt: start, dueAt: due }),
    );

    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toBe(msg('err.task.dueBeforeStart'));
    expect(tasks).toHaveLength(0);
  });

  // guards: BR-TASK-004
  it('початок = термін, лише початок, лише термін — дозволено; мітки часу зберігаються як є', async () => {
    const { service, tasks } = taskHarness();

    await service.create(ORG, managerActor, parse({ startAt: start, dueAt: start }));
    await service.create(ORG, managerActor, parse({ startAt: start }));
    await service.create(ORG, managerActor, parse({ dueAt: due }));

    expect(tasks.map(t => [t.startAt, t.dueAt])).toEqual([
      [new Date(start), new Date(start)],
      [new Date(start), null],
      [null, new Date(due)],
    ]);
  });

  // guards: BR-TASK-004
  it('правка, що ставить термін раніше початку → 400, збережене не змінено', async () => {
    const task = fakeTask({ startAt: new Date(start), dueAt: new Date(start) });
    const { service, tasks } = taskHarness({ tasks: [task] });

    const e = await rejection(
      service.update(ORG, managerActor, task.id as string, {
        ...parse(),
        startAt: start,
        dueAt: due,
      }),
    );

    expect(e).toBeInstanceOf(BadRequestException);
    expect(tasks[0].dueAt).toEqual(new Date(start));
  });
});

describe("Задачі — прив'язки (BR-TASK-006)", () => {
  // guards: BR-TASK-006
  it("наряд, авто й клієнт своєї організації → прив'язано, назви у відповіді", async () => {
    const { service } = taskHarness();

    const res = await service.create(
      ORG,
      managerActor,
      parse({ workOrderId: WO_ID, vehicleId: VEHICLE_ID, counterpartyId: CP_ID }),
    );

    expect(res).toMatchObject({
      workOrderNumber: 'НРД-1',
      workOrderDeleted: false,
      vehicleSummary: 'Škoda Octavia (AA1234BB)',
      counterpartyName: 'Петренко Олена',
    });
  });

  // guards: BR-TASK-006
  it.each([
    ['видалений наряд', { workOrderId: WO_DELETED }, 'err.task.workOrderNotFound'],
    ['наряд іншої організації', { workOrderId: WO_FOREIGN }, 'err.task.workOrderNotFound'],
    ['невідоме авто', { vehicleId: WO_ID }, 'err.task.vehicleNotFound'],
    ['невідомий клієнт', { counterpartyId: WO_ID }, 'err.task.counterpartyNotFound'],
  ] as const)('%s → 400, задачу не створено', async (_why, links, key) => {
    const { service, tasks } = taskHarness();

    const e = await rejection(service.create(ORG, managerActor, parse(links)));

    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as Error).message).toBe(msg(key));
    expect(tasks).toHaveLength(0);
  });

  // guards: BR-TASK-006
  it('наряд видалили після постановки: задача лишається, правка назви проходить, наряд — «видалений»', async () => {
    const task = fakeTask({ workOrderId: WO_DELETED });
    const { service, tasks } = taskHarness({ tasks: [task] });

    const res = await service.update(
      ORG,
      managerActor,
      task.id as string,
      parse({ title: 'Нова назва', workOrderId: WO_DELETED }),
    );

    expect(tasks[0]).toMatchObject({ title: 'Нова назва', workOrderId: WO_DELETED });
    expect(res).toMatchObject({ workOrderNumber: 'НРД-2', workOrderDeleted: true });
  });

  // guards: BR-TASK-006
  it("PATCH — повна форма: поле, якого немає, стирає прив'язку й опис", async () => {
    const task = fakeTask({ workOrderId: WO_ID, description: 'старий опис' });
    const { service, tasks } = taskHarness({ tasks: [task] });

    await service.update(ORG, managerActor, task.id as string, parse());

    expect(tasks[0]).toMatchObject({ workOrderId: null, description: null });
  });
});
