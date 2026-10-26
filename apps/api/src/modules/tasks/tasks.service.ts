import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, TaskStatus } from '@prisma/client';
import {
  TASK_STATUS_TRANSITIONS,
  canTransitionTask,
  isTaskManagerRole,
  type TaskFormValues,
} from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { assertFsmTransition } from '../../common/utils/fsm';
import { err } from '../../common/utils/err';
import { kyivDayEnd, kyivDayStart } from '../../common/utils/kyiv-date';
import { searchContains } from '../../common/utils/like-pattern';
import { calculatePagination } from '../../common/utils/pagination';
import type { PaginatedTasksDto, TaskListQueryDto, TaskResponseDto } from './tasks.dto';

/** Хто звертається: `id` — працівник із токена, `role` — його роль. */
export interface TaskActor {
  id: string;
  role: string;
}

/** Статуси, у яких задача ще «відкрита»: лише вони можуть бути простроченими (BR-TASK-005). */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['NEW', 'IN_PROGRESS'];

/**
 * BR-TASK-002: ролі керування бачать усі задачі організації, решта — лише свої. Умова йде в
 * `where` КОЖНОГО читання (список, картка, перехід, коментарі), а не в UI.
 */
export function taskVisibilityWhere(actor: TaskActor): Prisma.TaskWhereInput {
  return isTaskManagerRole(actor.role) ? {} : { assigneeId: actor.id };
}

/** BR-TASK-005: прострочена = термін минув і статус NEW / IN_PROGRESS. */
export function isTaskOverdue(
  t: { dueAt: Date | null; status: TaskStatus },
  now: Date = new Date(),
): boolean {
  return (
    t.dueAt !== null && t.dueAt.getTime() < now.getTime() && OPEN_TASK_STATUSES.includes(t.status)
  );
}

/** Умова Prisma «прострочена» — дзеркало `isTaskOverdue`. */
export function overdueWhere(now: Date): Prisma.TaskWhereInput {
  return { dueAt: { lt: now }, status: { in: [...OPEN_TASK_STATUSES] } };
}

/**
 * BR-TASK-004 / 007: задача в календарі займає проміжок [startAt ?? dueAt, dueAt ?? startAt]
 * (лише термін — точка в момент терміну). Умова — перетин цього проміжку з днями `from`…`to`
 * за Києвом включно. Задача без обох дат не має місця в календарі й у відбір не потрапляє.
 */
export function taskRangeWhere(from?: string, to?: string): Prisma.TaskWhereInput | undefined {
  if (!from && !to) return undefined;
  const start = from ? kyivDayStart(from) : undefined;
  const end = to ? kyivDayEnd(to) : undefined;
  // `not: null` явно: умова на кшталт `lte` сама по собі NULL не відкидає в кожному читачі
  // (сховище тестів, мобільний клієнт) — тут вона однозначна.
  const within = { not: null, ...(start && { gte: start }), ...(end && { lte: end }) };
  return {
    OR: [
      // Обидві дати: проміжок перетинає [start, end].
      {
        startAt: { not: null, ...(end && { lte: end }) },
        dueAt: { not: null, ...(start && { gte: start }) },
      },
      // Лише початок або лише термін — точка всередині [start, end].
      { dueAt: null, startAt: within },
      { startAt: null, dueAt: within },
    ],
  };
}

const TASK_INCLUDE = {
  assignee: { select: { firstName: true, lastName: true } },
  createdBy: { select: { firstName: true, lastName: true } },
  workOrder: { select: { number: true, deletedAt: true } },
  vehicle: { select: { make: true, model: true, licensePlate: true } },
  counterparty: { select: { companyName: true, firstName: true, lastName: true } },
} satisfies Prisma.TaskInclude;

type TaskRow = Prisma.TaskGetPayload<{ include: typeof TASK_INCLUDE }>;

// «Прізвище Ім'я» — як механік запису календаря й поле «Виконавець» картки.
const personName = (p: { firstName: string | null; lastName: string | null } | null): string =>
  p ? [p.lastName, p.firstName].filter(Boolean).join(' ') : '';

function toDto(t: TaskRow, now: Date): TaskResponseDto {
  const v = t.vehicle;
  const cp = t.counterparty;
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    assigneeId: t.assigneeId,
    assigneeName: personName(t.assignee),
    createdById: t.createdById,
    createdByName: personName(t.createdBy),
    startAt: t.startAt?.toISOString() ?? null,
    dueAt: t.dueAt?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
    workOrderId: t.workOrderId,
    workOrderNumber: t.workOrder?.number ?? null,
    workOrderDeleted: !!t.workOrder?.deletedAt,
    vehicleId: t.vehicleId,
    vehicleSummary: v
      ? `${v.make} ${v.model}${v.licensePlate ? ` (${v.licensePlate})` : ''}`.trim()
      : null,
    counterpartyId: t.counterpartyId,
    counterpartyName: cp
      ? cp.companyName || [cp.lastName, cp.firstName].filter(Boolean).join(' ') || null
      : null,
    overdue: isTaskOverdue(t, now),
    syncVersion: Number(t.syncVersion),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

const isTrue = (v?: string): boolean => v === 'true' || v === '1';

/** Збережені посилання задачі — щоб при зміні перевіряти лише змінені (BR-TASK-001, 006). */
type SavedTaskRefs = {
  assigneeId: string;
  workOrderId: string | null;
  vehicleId: string | null;
  counterpartyId: string | null;
};

@Injectable()
export class TasksService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    orgId: string,
    actor: TaskActor,
    query: TaskListQueryDto,
  ): Promise<PaginatedTasksDto> {
    const now = new Date();
    const { skip, take } = calculatePagination({ page: query.page, limit: query.limit });
    const and: Prisma.TaskWhereInput[] = [taskVisibilityWhere(actor)];
    if (query.status?.length) and.push({ status: { in: [...new Set(query.status)] } });
    if (query.priority?.length) and.push({ priority: { in: [...new Set(query.priority)] } });
    if (query.assigneeId) and.push({ assigneeId: query.assigneeId });
    if (isTrue(query.mine)) and.push({ assigneeId: actor.id });
    if (isTrue(query.overdue)) and.push(overdueWhere(now));
    if (query.workOrderId) and.push({ workOrderId: query.workOrderId });
    if (query.id) and.push({ id: query.id });
    const range = taskRangeWhere(query.from, query.to);
    if (range) and.push(range);
    const contains = searchContains(query.q);
    if (contains) and.push({ title: contains });

    const where: Prisma.TaskWhereInput = { orgId, deletedAt: null, AND: and };
    const dir = query.sortDir ?? 'asc';
    const sortBy = query.sortBy ?? 'dueAt';
    const primary: Prisma.TaskOrderByWithRelationInput =
      sortBy === 'dueAt' || sortBy === 'startAt' || sortBy === 'completedAt'
        ? { [sortBy]: { sort: dir, nulls: 'last' } }
        : { [sortBy]: dir };
    const [rows, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        include: TASK_INCLUDE,
        orderBy: [primary, { createdAt: 'desc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.task.count({ where }),
    ]);
    return { items: rows.map(r => toDto(r, now)), total, page: query.page, limit: take };
  }

  async findOne(orgId: string, actor: TaskActor, id: string): Promise<TaskResponseDto> {
    const row = await this.prisma.task.findFirst({
      where: { id, orgId, deletedAt: null, ...taskVisibilityWhere(actor) },
      include: TASK_INCLUDE,
    });
    if (!row) throw new NotFoundException(err('err.task.notFound'));
    return toDto(row, new Date());
  }

  /** BR-TASK-001 (ролі — у контролері), 004, 006. */
  async create(orgId: string, actor: TaskActor, dto: TaskFormValues): Promise<TaskResponseDto> {
    const data = await this.validatedFields(orgId, dto);
    const created = await this.prisma.task.create({
      data: { ...data, orgId, createdById: actor.id },
      select: { id: true },
    });
    return this.findOne(orgId, actor, created.id);
  }

  /**
   * PATCH — повна форма (`taskFormSchema`): необов'язкове поле, якого немає, стирається. Статус
   * тут не змінюється — лише через `transition` (BR-TASK-003).
   */
  async update(
    orgId: string,
    actor: TaskActor,
    id: string,
    dto: TaskFormValues,
  ): Promise<TaskResponseDto> {
    const saved = await this.prisma.task.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { assigneeId: true, workOrderId: true, vehicleId: true, counterpartyId: true },
    });
    if (!saved) throw new NotFoundException(err('err.task.notFound'));
    const data = await this.validatedFields(orgId, dto, saved);
    const res = await this.prisma.task.updateMany({
      where: { id, orgId, deletedAt: null },
      data,
    });
    if (res.count === 0) throw new NotFoundException(err('err.task.notFound'));
    return this.findOne(orgId, actor, id);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const res = await this.prisma.task.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (res.count === 0) throw new NotFoundException(err('err.task.notFound'));
  }

  /**
   * BR-TASK-003: перехід за `TASK_STATUS_TRANSITIONS`; виконавець — лише своєї задачі й без
   * скасування та повернення виконаної в роботу. Запис — CAS за попереднім статусом: два
   * одночасні переходи не перескакують FSM.
   */
  async transition(
    orgId: string,
    actor: TaskActor,
    id: string,
    to: TaskStatus,
  ): Promise<TaskResponseDto> {
    const task = await this.prisma.task.findFirst({
      where: { id, orgId, deletedAt: null, ...taskVisibilityWhere(actor) },
      select: { status: true, assigneeId: true },
    });
    if (!task) throw new NotFoundException(err('err.task.notFound'));
    assertFsmTransition<string>(TASK_STATUS_TRANSITIONS, task.status, to);
    const allowed = canTransitionTask(task.status, to, {
      isManager: isTaskManagerRole(actor.role),
      isAssignee: task.assigneeId === actor.id,
    });
    if (!allowed) throw new BadRequestException(err('err.task.transitionForbidden'));

    const completedAt = to === 'DONE' ? new Date() : task.status === 'DONE' ? null : undefined;
    // CAS за статусом І видимістю: задачу, переназначену між читанням і записом, колишній
    // виконавець уже не рухає (BR-TASK-002 / 003).
    const res = await this.prisma.task.updateMany({
      where: { id, orgId, deletedAt: null, status: task.status, ...taskVisibilityWhere(actor) },
      data: { status: to, ...(completedAt !== undefined && { completedAt }) },
    });
    if (res.count === 0) {
      throw new BadRequestException(err('err.fsm.transitionNotAllowed', { from: task.status, to }));
    }
    return this.findOne(orgId, actor, id);
  }

  /**
   * Поля форми → дані запису з перевірками BR-TASK-001 (виконавець), 004 (початок ≤ термін) і
   * 006 (прив'язки своєї організації, не видалені). Порожні необов'язкові поля — `null`.
   *
   * `saved` — збережена задача (зміна): перевіряється лише те, що змінилось. Виконавець, який
   * пішов у відпустку, чи наряд, видалений після постановки задачі (BR-TASK-006), не заважають
   * виправити назву чи термін.
   */
  private async validatedFields(orgId: string, dto: TaskFormValues, saved?: SavedTaskRefs) {
    const startAt = dto.startAt ? new Date(dto.startAt) : null;
    const dueAt = dto.dueAt ? new Date(dto.dueAt) : null;
    if (startAt && dueAt && startAt.getTime() > dueAt.getTime()) {
      throw new BadRequestException(err('err.task.dueBeforeStart'));
    }
    const changed = (key: keyof SavedTaskRefs): string | undefined => {
      const next = dto[key] ?? null;
      return next !== null && next !== (saved?.[key] ?? null) ? next : undefined;
    };
    const assigneeId = changed('assigneeId');
    const workOrderId = changed('workOrderId');
    const vehicleId = changed('vehicleId');
    const counterpartyId = changed('counterpartyId');
    const live = { orgId, deletedAt: null } as const;
    const [assignee, workOrder, vehicle, counterparty] = await Promise.all([
      assigneeId
        ? this.prisma.employee.findFirst({
            where: { id: assigneeId, ...live },
            select: { status: true },
          })
        : null,
      workOrderId
        ? this.prisma.workOrder.findFirst({
            where: { id: workOrderId, ...live },
            select: { id: true },
          })
        : null,
      vehicleId
        ? this.prisma.vehicle.findFirst({ where: { id: vehicleId, ...live }, select: { id: true } })
        : null,
      counterpartyId
        ? this.prisma.counterparty.findFirst({
            where: { id: counterpartyId, ...live },
            select: { id: true },
          })
        : null,
    ]);
    if (assigneeId && (!assignee || assignee.status === 'FIRED')) {
      throw new BadRequestException(err('err.task.assigneeNotFound'));
    }
    if (assignee?.status === 'ON_LEAVE') {
      throw new BadRequestException(err('err.task.assigneeOnLeave'));
    }
    if (workOrderId && !workOrder) throw new BadRequestException(err('err.task.workOrderNotFound'));
    if (vehicleId && !vehicle) throw new BadRequestException(err('err.task.vehicleNotFound'));
    if (counterpartyId && !counterparty) {
      throw new BadRequestException(err('err.task.counterpartyNotFound'));
    }
    return {
      title: dto.title,
      description: dto.description ?? null,
      priority: dto.priority,
      assigneeId: dto.assigneeId,
      startAt,
      dueAt,
      workOrderId: dto.workOrderId ?? null,
      vehicleId: dto.vehicleId ?? null,
      counterpartyId: dto.counterpartyId ?? null,
    };
  }
}
