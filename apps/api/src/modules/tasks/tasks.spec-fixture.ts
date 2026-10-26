import { vi } from 'vitest';
import { matchesWhere } from '../calendar/calendar.spec-fixture';
import { TasksService } from './tasks.service';
import type { PrismaService } from '../../prisma/prisma.service';

// Таблиці задач і довідників у пам'яті для аспектних спеків задач.
//
// Навіщо: видимість (BR-TASK-002), прострочення (005) і відбір за днями (004/007) — це Prisma
// `where`. Мок `findMany.mockResolvedValue([...])` його не виконує, і зниклий `assigneeId` у
// фільтрі виконавця лишався б непоміченим. Тут `where` справді обчислюється над рядками
// (`matchesWhere` календаря); `include` віддає зв'язки, що лежать у рядку.
//
// Factory, не const: `isolate: false` без `clearMocks` — спільний стан протікав би між файлами.

type Row = Record<string, unknown>;

export const ORG = 'org-1';
export const OTHER_ORG = 'org-2';
export const MANAGER = '11111111-1111-4111-8111-000000000001';
export const MECH_A = '11111111-1111-4111-8111-00000000000a';
export const MECH_B = '11111111-1111-4111-8111-00000000000b';
export const ON_LEAVE = '11111111-1111-4111-8111-0000000000c1';
export const FIRED = '11111111-1111-4111-8111-0000000000c2';
export const FOREIGN_EMP = '11111111-1111-4111-8111-0000000000c3';
export const WO_ID = '22222222-2222-4222-8222-000000000001';
export const WO_DELETED = '22222222-2222-4222-8222-000000000002';
export const WO_FOREIGN = '22222222-2222-4222-8222-000000000003';
export const VEHICLE_ID = '33333333-3333-4333-8333-000000000001';
export const CP_ID = '44444444-4444-4444-8444-000000000001';

export const managerActor = { id: MANAGER, role: 'ADMIN' };
export const mechA = { id: MECH_A, role: 'MECHANIC' };
export const mechB = { id: MECH_B, role: 'MECHANIC' };

const emp = (id: string, firstName: string, over: Row = {}): Row => ({
  id,
  orgId: ORG,
  firstName,
  lastName: 'Тест',
  status: 'ACTIVE',
  deletedAt: null,
  ...over,
});

export function defaultEmployees(): Row[] {
  return [
    emp(MANAGER, 'Адмін'),
    emp(MECH_A, 'Андрій'),
    emp(MECH_B, 'Богдан'),
    emp(ON_LEAVE, 'Відпустка', { status: 'ON_LEAVE' }),
    emp(FIRED, 'Звільнений', { status: 'FIRED' }),
    emp(FOREIGN_EMP, 'Чужий', { orgId: OTHER_ORG }),
  ];
}

export function defaultWorkOrders(): Row[] {
  return [
    { id: WO_ID, orgId: ORG, number: 'НРД-1', deletedAt: null },
    { id: WO_DELETED, orgId: ORG, number: 'НРД-2', deletedAt: new Date('2026-01-01') },
    { id: WO_FOREIGN, orgId: OTHER_ORG, number: 'НРД-3', deletedAt: null },
  ];
}

let seq = 0;

/** Задача з дефолтами: NEW / NORMAL, механік A, без дат і прив'язок. */
export function fakeTask(over: Row = {}): Row {
  seq += 1;
  return {
    id: `55555555-5555-4555-8555-${String(seq).padStart(12, '0')}`,
    orgId: ORG,
    title: `Задача ${seq}`,
    description: null,
    status: 'NEW',
    priority: 'NORMAL',
    assigneeId: MECH_A,
    createdById: MANAGER,
    startAt: null,
    dueAt: null,
    completedAt: null,
    workOrderId: null,
    vehicleId: null,
    counterpartyId: null,
    syncVersion: 1n,
    createdAt: new Date('2026-05-01T08:00:00Z'),
    updatedAt: new Date('2026-05-01T08:00:00Z'),
    deletedAt: null,
    ...over,
  };
}

interface Tables {
  tasks?: Row[];
  employees?: Row[];
  workOrders?: Row[];
  vehicles?: Row[];
  counterparties?: Row[];
}

const pick = (rows: Row[], id: unknown): Row | null => rows.find(r => r.id === id) ?? null;

/**
 * Prisma-мок над таблицями: `task.findFirst/findMany/count/updateMany` обчислюють `where`,
 * `create` / `updateMany` змінюють масив; `include` збирає зв'язки з довідників. Довідники
 * (працівники, наряди, авто, клієнти) читаються `findFirst` теж через `where`.
 */
export function buildTaskStore(tables: Tables = {}) {
  const tasks = tables.tasks ?? [];
  const employees = tables.employees ?? defaultEmployees();
  const workOrders = tables.workOrders ?? defaultWorkOrders();
  const vehicles = tables.vehicles ?? [
    {
      id: VEHICLE_ID,
      orgId: ORG,
      make: 'Škoda',
      model: 'Octavia',
      licensePlate: 'AA1234BB',
      deletedAt: null,
    },
  ];
  const counterparties = tables.counterparties ?? [
    {
      id: CP_ID,
      orgId: ORG,
      companyName: null,
      firstName: 'Олена',
      lastName: 'Петренко',
      deletedAt: null,
    },
  ];

  const withRelations = (t: Row): Row => ({
    ...t,
    assignee: pick(employees, t.assigneeId),
    createdBy: pick(employees, t.createdById),
    workOrder: pick(workOrders, t.workOrderId),
    vehicle: pick(vehicles, t.vehicleId),
    counterparty: pick(counterparties, t.counterpartyId),
  });
  const project = (t: Row, select?: Record<string, unknown>): Row => {
    if (!select) return withRelations(t);
    return Object.fromEntries(Object.keys(select).map(k => [k, t[k]]));
  };

  type Args = { where: Row; select?: Record<string, unknown>; skip?: number; take?: number };
  const task = {
    findFirst: vi.fn(({ where, select }: Args) => {
      const row = tasks.find(r => matchesWhere(r, where));
      return Promise.resolve(row ? project(row, select) : null);
    }),
    findMany: vi.fn(({ where, skip = 0, take }: Args) => {
      const rows = tasks.filter(r => matchesWhere(r, where)).map(withRelations);
      return Promise.resolve(rows.slice(skip, take === undefined ? undefined : skip + take));
    }),
    count: vi.fn(({ where }: Args) =>
      Promise.resolve(tasks.filter(r => matchesWhere(r, where)).length),
    ),
    create: vi.fn(({ data }: { data: Row }) => {
      const row = fakeTask(data);
      tasks.push(row);
      return Promise.resolve({ id: row.id });
    }),
    updateMany: vi.fn(({ where, data }: { where: Row; data: Row }) => {
      const hit = tasks.filter(r => matchesWhere(r, where));
      for (const r of hit) Object.assign(r, data);
      return Promise.resolve({ count: hit.length });
    }),
  };
  const lookup = (rows: Row[]) => ({
    findFirst: vi.fn(({ where, select }: Args) => {
      const row = rows.find(r => matchesWhere(r, where));
      return Promise.resolve(row ? project(row, select) : null);
    }),
  });

  return {
    task,
    employee: lookup(employees),
    workOrder: lookup(workOrders),
    vehicle: lookup(vehicles),
    counterparty: lookup(counterparties),
    _tasks: tasks,
  };
}

export function taskHarness(tables: Tables = {}) {
  const prisma = buildTaskStore(tables);
  const service = new TasksService(prisma as unknown as PrismaService);
  return { prisma, service, tasks: prisma._tasks };
}
