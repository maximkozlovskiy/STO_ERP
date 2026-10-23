import { describe, it, expect, vi } from 'vitest';
import { translateError } from '@sto/shared';
import { SyncService } from './sync.service';
import { matchesWhere } from '../calendar/calendar.spec-fixture';
import type { SyncRecord } from '@sto/shared';

// Синхронізація з планшета (`sync push calendar_slots`) перевіряє запис календаря так само, як
// API календаря (рішення власника 2026-10-16): механік — активний MECHANIC організації,
// закріплений за підйомником запису (BR-CAL-012), а змінюють записи лише ролі BR-CAL-010.
// Відмова — у форматі будь-якого конфлікту синхронізації: `conflicts + 1` і `SyncJob` FAILED з
// причиною в `lastError`; запис не змінюється.
//
// Працівники — таблиця в пам'яті, що ВИКОНУЄ Prisma `where` (`matchesWhere`), тож тест бачить,
// КОГО приймає перевірка, а не форму запиту.

const ORG = 'org-1';
const LIFT_1 = '22222222-2222-4222-8222-222222222222';
const LIFT_2 = '22222222-2222-4222-8222-333333333333';
const MECH = '33333333-3333-4333-8333-000000000001';
const MECH_BOTH = '33333333-3333-4333-8333-000000000002';
const ON_LEAVE = '33333333-3333-4333-8333-000000000003';
const FIRED = '33333333-3333-4333-8333-000000000004';
const SLOT_ID = '44444444-4444-4444-8444-000000000001';
const WO_LIVE = '55555555-5555-4555-8555-000000000001';
const WO_CANCELLED = '55555555-5555-4555-8555-000000000002';

function employee(id: string, lifts: string[], over: Record<string, unknown> = {}) {
  return {
    id,
    orgId: ORG,
    role: 'MECHANIC',
    status: 'ACTIVE',
    deletedAt: null,
    employeeLifts: lifts.map(liftId => ({ liftId })),
    ...over,
  };
}

const EMPLOYEES = [
  employee(MECH, [LIFT_1]),
  employee(MECH_BOTH, [LIFT_1, LIFT_2]),
  employee(ON_LEAVE, [LIFT_1], { status: 'ON_LEAVE' }),
  employee(FIRED, [LIFT_1], { status: 'FIRED' }),
];

// Наряди — теж таблиця в пам'яті, що виконує `where` і віддає лише поля з `select`: тест
// бачить, чи сервіс справді ЧИТАЄ статус наряду, а не отримує його з заготовки.
const WORK_ORDERS = [
  { id: WO_LIVE, orgId: ORG, status: 'APPROVED', deletedAt: null },
  { id: WO_CANCELLED, orgId: ORG, status: 'CANCELLED', deletedAt: null },
];

function pick(row: Record<string, unknown>, select: Record<string, boolean>) {
  return Object.fromEntries(
    Object.keys(select)
      .filter(k => select[k])
      .map(k => [k, row[k]]),
  );
}

const WO_CANCELLED_MSG = translateError('err.calendar.workOrderCancelled', 'uk');
const NOT_ON_LIFT = translateError('err.calendar.employeeNotOnLift', 'uk');
const ON_LEAVE_MSG = translateError('err.calendar.employeeOnLeave', 'uk');
const NOT_FOUND = translateError('err.calendar.employeeNotFound', 'uk');
const ROLE_FORBIDDEN = translateError('err.calendar.syncRoleForbidden', 'uk');

function harness(existing: Record<string, unknown> | null = null) {
  const exists = () =>
    vi.fn(({ where }: { where: { id: string } }) => Promise.resolve({ id: where.id }));
  const prisma = {
    calendarSlot: {
      findFirst: vi.fn().mockResolvedValue(existing),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    counterparty: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    employee: {
      findFirst: vi.fn(({ where }: { where: Record<string, unknown> }) => {
        const found = EMPLOYEES.find(e => matchesWhere(e, where));
        return Promise.resolve(found ? { id: found.id, status: found.status } : null);
      }),
    },
    lift: { findFirst: exists() },
    workOrder: {
      findFirst: vi.fn(
        ({
          where,
          select,
        }: {
          where: Record<string, unknown>;
          select: Record<string, boolean>;
        }) => {
          const found = WORK_ORDERS.find(w => matchesWhere(w, where));
          return Promise.resolve(found ? pick(found, select) : null);
        },
      ),
    },
    syncJob: { create: vi.fn().mockResolvedValue({}) },
  };
  // Записи без наряду і нові записи — без наряду (BR-WO-024: `sync.work-order-slot.spec.ts`).
  const workOrders = { updateCalendarSlot: vi.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new SyncService(prisma as any, workOrders as never, { del: vi.fn() } as never);
  const lastErrors = () =>
    prisma.syncJob.create.mock.calls.map(
      c => (c[0] as { data: { lastError: string; status: string } }).data,
    );
  return { service, prisma, lastErrors };
}

const record = (over: Partial<SyncRecord> & { payload?: Record<string, unknown> }): SyncRecord =>
  ({
    table: 'calendar_slots',
    id: SLOT_ID,
    operation: 'INSERT',
    syncVersion: 5,
    payload: {},
    ...over,
  }) as SyncRecord;

const slotPayload = (over: Record<string, unknown> = {}) => ({
  liftId: LIFT_1,
  employeeId: MECH,
  startAt: '2026-06-15T07:00:00.000Z',
  endAt: '2026-06-15T08:00:00.000Z',
  ...over,
});

describe('SyncService.push calendar_slots — механік за підйомником (BR-CAL-012)', () => {
  // guards: BR-CAL-012
  it('новий запис із закріпленим механіком → прийнято', async () => {
    const h = harness();
    const res = await h.service.push(ORG, [record({ payload: slotPayload() })], 'ADMIN');
    expect(res).toEqual({ accepted: 1, conflicts: 0 });
    expect(h.prisma.calendarSlot.create).toHaveBeenCalledTimes(1);
  });

  // guards: BR-CAL-012
  it.each([
    ['не закріплений за підйомником', { employeeId: MECH, liftId: LIFT_2 }, NOT_ON_LIFT],
    ['у відпустці', { employeeId: ON_LEAVE }, ON_LEAVE_MSG],
    ['звільнений', { employeeId: FIRED }, NOT_FOUND],
    ['без підйомника', { employeeId: MECH, liftId: null }, NOT_ON_LIFT],
  ])('новий запис, механік %s → відмова з причиною, запис не створено', async (_l, over, msg) => {
    const h = harness();
    const res = await h.service.push(ORG, [record({ payload: slotPayload(over) })], 'ADMIN');
    expect(res).toEqual({ accepted: 0, conflicts: 1 });
    expect(h.prisma.calendarSlot.create).not.toHaveBeenCalled();
    expect(h.lastErrors()).toEqual([expect.objectContaining({ status: 'FAILED', lastError: msg })]);
  });

  // guards: BR-CAL-012
  it('зміна підйомника, механік не закріплений за новим → відмова, запис не змінено', async () => {
    const h = harness({
      id: SLOT_ID,
      syncVersion: 1n,
      deletedAt: null,
      workOrderId: null,
      liftId: LIFT_1,
      employeeId: MECH,
    });
    const res = await h.service.push(
      ORG,
      [record({ operation: 'UPDATE', payload: { liftId: LIFT_2 } })],
      'RECEPTIONIST',
    );
    expect(res).toEqual({ accepted: 0, conflicts: 1 });
    expect(h.prisma.calendarSlot.update).not.toHaveBeenCalled();
    expect(h.lastErrors()[0]).toMatchObject({ lastError: NOT_ON_LIFT });
  });

  // guards: BR-CAL-012
  it('зміна підйомника, механік закріплений і за новим → прийнято', async () => {
    const h = harness({
      id: SLOT_ID,
      syncVersion: 1n,
      deletedAt: null,
      workOrderId: null,
      liftId: LIFT_1,
      employeeId: MECH_BOTH,
    });
    const res = await h.service.push(
      ORG,
      [record({ operation: 'UPDATE', payload: { liftId: LIFT_2 } })],
      'ADMIN',
    );
    expect(res).toEqual({ accepted: 1, conflicts: 0 });
    expect(h.prisma.calendarSlot.update).toHaveBeenCalledTimes(1);
  });

  // guards: BR-CAL-012
  it('збережений механік у відпустці, змінено лише нотатки → прийнято без перевірки', async () => {
    const h = harness({
      id: SLOT_ID,
      syncVersion: 1n,
      deletedAt: null,
      workOrderId: null,
      liftId: LIFT_1,
      employeeId: ON_LEAVE,
    });
    const res = await h.service.push(
      ORG,
      [record({ operation: 'UPDATE', payload: { notes: 'Перевірити гальма' } })],
      'ADMIN',
    );
    expect(res).toEqual({ accepted: 1, conflicts: 0 });
    expect(h.prisma.employee.findFirst).not.toHaveBeenCalled();
  });
});

describe('SyncService.push calendar_slots — ролі календаря (BR-CAL-010)', () => {
  // guards: BR-CAL-010
  it.each(['INSERT', 'UPDATE', 'DELETE'] as const)(
    'MECHANIC, %s → відмова з причиною, нічого не читає й не пише',
    async operation => {
      const h = harness({
        id: SLOT_ID,
        syncVersion: 1n,
        deletedAt: null,
        workOrderId: null,
        liftId: LIFT_1,
        employeeId: MECH,
      });
      const res = await h.service.push(
        ORG,
        [record({ operation, payload: slotPayload() })],
        'MECHANIC',
      );
      expect(res).toEqual({ accepted: 0, conflicts: 1 });
      expect(h.prisma.calendarSlot.findFirst).not.toHaveBeenCalled();
      expect(h.prisma.calendarSlot.create).not.toHaveBeenCalled();
      expect(h.prisma.calendarSlot.update).not.toHaveBeenCalled();
      expect(h.lastErrors()).toEqual([expect.objectContaining({ lastError: ROLE_FORBIDDEN })]);
    },
  );

  // guards: BR-CAL-010
  it.each(['OWNER', 'ADMIN', 'RECEPTIONIST'])('%s → запис прийнято', async role => {
    const h = harness();
    const res = await h.service.push(ORG, [record({ payload: slotPayload() })], role);
    expect(res).toEqual({ accepted: 1, conflicts: 0 });
  });

  it('роль не стосується інших таблиць: MECHANIC і контрагент — без відмови за роллю', async () => {
    const h = harness();
    await h.service.push(
      ORG,
      [record({ table: 'counterparties', payload: { firstName: 'Іван' } })],
      'MECHANIC',
    );
    expect(h.lastErrors()).toEqual([]);
    expect(h.prisma.counterparty.create).toHaveBeenCalledTimes(1);
  });

  it('колонки запису календаря читаються лише для calendar_slots (у контрагента їх немає)', async () => {
    const h = harness();
    await h.service.push(ORG, [record({ table: 'counterparties', payload: {} })], 'ADMIN');
    const select = h.prisma.counterparty.findFirst.mock.calls[0]![0].select as Record<
      string,
      unknown
    >;
    expect(select).toEqual({ id: true, syncVersion: true, deletedAt: true });
  });
});

describe('SyncService.push calendar_slots — скасований наряд (BR-WO-022)', () => {
  // guards: BR-WO-022
  it.each([
    ['новий запис', null],
    [
      'зміна наряду запису',
      { id: SLOT_ID, syncVersion: 1n, deletedAt: null, workOrderId: null, liftId: LIFT_1 },
    ],
  ])('%s зі скасованим нарядом → відмова з причиною, нічого не записано', async (_l, existing) => {
    const h = harness(existing);
    const res = await h.service.push(
      ORG,
      [
        record({
          operation: existing ? 'UPDATE' : 'INSERT',
          payload: slotPayload({ workOrderId: WO_CANCELLED }),
        }),
      ],
      'ADMIN',
    );
    expect(res).toEqual({ accepted: 0, conflicts: 1 });
    expect(h.prisma.calendarSlot.create).not.toHaveBeenCalled();
    expect(h.prisma.calendarSlot.update).not.toHaveBeenCalled();
    expect(h.lastErrors()).toEqual([
      expect.objectContaining({ status: 'FAILED', lastError: WO_CANCELLED_MSG }),
    ]);
  });

  // guards: BR-WO-022
  it('новий запис живого наряду → прийнято', async () => {
    const h = harness();
    const res = await h.service.push(
      ORG,
      [record({ payload: slotPayload({ workOrderId: WO_LIVE }) })],
      'ADMIN',
    );
    expect(res).toEqual({ accepted: 1, conflicts: 0 });
    expect(h.prisma.calendarSlot.create).toHaveBeenCalledTimes(1);
  });
});
