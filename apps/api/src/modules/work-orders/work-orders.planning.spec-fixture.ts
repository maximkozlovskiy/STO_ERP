/**
 * Harness для аспектних спеків планування наряду: планові дати (BR-WO-019) і запис календаря
 * наряду (BR-WO-020).
 *
 * Справжні `WorkOrdersService` і `CalendarService` над таблицями в пам'яті (`memoryTable`):
 * Prisma `where` виконується по-справжньому (зокрема `orgId`, `notIn`, перетин часу, зв'язок
 * `workOrder: { is }`), тож тест бачить, ЯКІ записи календаря створено, перенесено чи позначено,
 * а не форму запиту. `$transaction` знімає знімок таблиць і відновлює його при винятку — як
 * відкат у БД: «наряд не змінено» перевіряється рядком наряду після відмови.
 *
 * DI-DRIFT GUARD: нова залежність у конструкторі WorkOrdersService правиться тут.
 * Factory, не const: `isolate: false` без `clearMocks`.
 */
import { vi } from 'vitest';
import { WorkOrdersService } from './work-orders.service';
import { CalendarService } from '../calendar/calendar.service';
import { matchesWhere } from '../calendar/calendar.spec-fixture';
import { memoryTable, type MemRow } from '../cash/cash.spec-fixture';
import type { PrismaService } from '../../prisma/prisma.service';

export const ORG = '11111111-1111-4111-8111-111111111111';
export const OTHER_ORG = '11111111-1111-4111-8111-999999999999';
/** Філія з налаштуваннями 08:00–18:00 (як dev-seed). */
export const BRANCH = '21111111-1111-4111-8111-111111111111';
/** Філія без рядка BranchSettings → типові 09:00–18:00. */
export const BRANCH_NO_SETTINGS = '21111111-1111-4111-8111-222222222222';
export const LIFT_1 = '31111111-1111-4111-8111-111111111111';
export const LIFT_2 = '31111111-1111-4111-8111-222222222222';
export const VEHICLE = '41111111-1111-4111-8111-111111111111';
export const CLIENT = '51111111-1111-4111-8111-111111111111';
export const WO_ID = '61111111-1111-4111-8111-111111111111';
export const OTHER_WO = '61111111-1111-4111-8111-222222222222';
/** Механік, закріплений лише за LIFT_1. */
export const MECH_1 = '71111111-1111-4111-8111-111111111111';
/** Механік, закріплений за обома підйомниками. */
export const MECH_BOTH = '71111111-1111-4111-8111-222222222222';

/** «Зараз» спеків: 20.05.2026 09:00 Києва (+03). */
export const NOW = new Date('2026-05-20T06:00:00.000Z');

/** Мить київського настінного часу травня 2026 (+03): `kyiv('2026-05-22', '10:00')`. */
export const kyiv = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00+03:00`);

const EMPLOYEES = [
  {
    id: MECH_1,
    orgId: ORG,
    role: 'MECHANIC',
    status: 'ACTIVE',
    deletedAt: null,
    employeeLifts: [{ liftId: LIFT_1 }],
  },
  {
    id: MECH_BOTH,
    orgId: ORG,
    role: 'MECHANIC',
    status: 'ACTIVE',
    deletedAt: null,
    employeeLifts: [{ liftId: LIFT_1 }, { liftId: LIFT_2 }],
  },
];

/** Рядок наряду з усім, що читає `toDto`. */
export function woRow(over: MemRow = {}): MemRow {
  return {
    id: WO_ID,
    orgId: ORG,
    number: 'НРД-7',
    status: 'DRAFT',
    priority: 'NORMAL',
    repairCategory: null,
    branchId: BRANCH,
    vehicleId: VEHICLE,
    counterpartyId: CLIENT,
    contractId: null,
    currencyId: 'cur-uah',
    liftId: null,
    description: null,
    inMileage: null,
    outMileage: null,
    plannedAt: null,
    dueDate: null,
    plannedHours: null,
    actualHours: null,
    completedAt: null,
    clientApproval: false,
    totalLabor: 0,
    totalActualLabor: 0,
    totalParts: 0,
    totalAmount: 0,
    paidAmount: 0,
    documentDate: new Date('2026-05-20'),
    createdAt: new Date('2026-05-19T08:00:00Z'),
    updatedAt: new Date('2026-05-19T08:00:00Z'),
    deletedAt: null,
    lines: [],
    parts: [],
    ...over,
  };
}

/** Запис календаря наряду (за замовчуванням — якір наряду WO_ID на LIFT_1). */
export function slotRow(id: string, over: MemRow = {}): MemRow {
  return {
    id,
    orgId: ORG,
    liftId: LIFT_1,
    employeeId: null,
    workOrderId: WO_ID,
    counterpartyId: null,
    vehicleId: null,
    parentSlotId: null,
    startAt: kyiv('2026-05-22', '10:00'),
    endAt: kyiv('2026-05-22', '12:00'),
    status: 'BOOKED',
    type: 'WORK',
    notes: null,
    deletedAt: null,
    ...over,
  };
}

export function planningHarness(opts: { workOrders?: MemRow[]; slots?: MemRow[] } = {}) {
  const workOrder = memoryTable(opts.workOrders ?? [woRow()], () => {
    const { id: _id, ...defaults } = woRow();
    return defaults;
  });
  let slotSeq = 0;
  const calendarSlot = memoryTable(
    opts.slots ?? [],
    () => {
      slotSeq += 1;
      return slotRow(`slot-new-${slotSeq}`);
    },
    { workOrder: row => workOrder.rows.find(w => w.id === row.workOrderId) },
  );
  const createMany = vi.fn(async (args: { data: MemRow[] }) => {
    for (const data of args.data) await calendarSlot.create({ data });
    return { count: args.data.length };
  });
  const slots = { ...calendarSlot, createMany };

  const branchSettings = memoryTable([
    { branchId: BRANCH, orgId: ORG, workStartTime: '08:00', workEndTime: '18:00' },
  ]);
  const employee = {
    findFirst: vi.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(EMPLOYEES.find(e => matchesWhere(e, where)) ?? null),
    ),
  };
  const exists = (rows: MemRow[]) => memoryTable(rows);
  const garageBranch = exists([
    { id: BRANCH, orgId: ORG, deletedAt: null },
    { id: BRANCH_NO_SETTINGS, orgId: ORG, deletedAt: null },
  ]);
  const vehicle = exists([{ id: VEHICLE, orgId: ORG, deletedAt: null }]);
  const counterparty = exists([{ id: CLIENT, orgId: ORG, deletedAt: null, type: 'CLIENT' }]);
  const lift = exists([
    { id: LIFT_1, orgId: ORG, deletedAt: null },
    { id: LIFT_2, orgId: ORG, deletedAt: null },
  ]);
  const counterpartyContract = exists([]);

  const tables: MemRow[][] = [workOrder.rows, calendarSlot.rows];
  const $transaction = vi.fn(async (cb: (tx: unknown) => unknown) => {
    const snapshot = tables.map(rows => rows.map(r => structuredClone(r)));
    try {
      return await cb(prisma);
    } catch (e) {
      tables.forEach((rows, i) => rows.splice(0, rows.length, ...snapshot[i]));
      throw e;
    }
  });
  const prisma = {
    workOrder,
    calendarSlot: slots,
    branchSettings,
    employee,
    garageBranch,
    vehicle,
    counterparty,
    lift,
    counterpartyContract,
    $transaction,
  };

  const calendar = new CalendarService(prisma as unknown as PrismaService);
  const docNumbers = { next: vi.fn().mockResolvedValue('НРД-8') };
  const service = new WorkOrdersService(
    prisma as unknown as PrismaService,
    null as never, // stockEffects
    docNumbers as never,
    null as never, // pdf
    { record: vi.fn().mockResolvedValue(undefined) } as never, // audit
    null as never, // settingsService
    { requireBaseCurrencyId: vi.fn().mockResolvedValue('cur-uah') } as never, // exchangeRates
    { emit: vi.fn() } as never, // events
    { recalc: vi.fn().mockResolvedValue(undefined) } as never, // totals (clone)
    null as never, // orgPrintInfo
    calendar,
  );

  /** Живі записи календаря наряду. */
  const liveSlots = (workOrderId = WO_ID) =>
    calendarSlot.rows.filter(r => r.workOrderId === workOrderId && r.deletedAt === null);

  return { service, prisma, workOrder, calendarSlot, createMany, docNumbers, liveSlots };
}

/** Тіло POST /work-orders для BRANCH. */
export function createDto(over: Record<string, unknown> = {}) {
  return {
    branchId: BRANCH,
    vehicleId: VEHICLE,
    counterpartyId: CLIENT,
    ...over,
  } as never;
}
