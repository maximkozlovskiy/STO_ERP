import { describe, it, expect, vi } from 'vitest';
import { CalendarService } from './calendar.service';

// Аспект «види слотів»: які комбінації полів CalendarSlot сервіс приймає і зберігає як є —
// прямий клієнт без наряду, підйомник без механіка, службові типи без наряду й клієнта.
// Правила — docs/objects/calendar.md, секція «Бізнес-правила (BR-CAL)».

const ORG_ID = 'org-1';
const LIFT_ID = '22222222-2222-4222-8222-222222222222';
const EMPLOYEE_ID = '33333333-3333-4333-8333-333333333333';
const COUNTERPARTY_ID = '44444444-4444-4444-8444-444444444444';
const SLOT_ID = '55555555-5555-4555-8555-555555555555';

// 13:00–14:00 Kyiv (травень, +03:00) — у межах робочого дня, split не спрацьовує.
const START_AT = '2026-05-22T10:00:00.000Z';
const END_AT = '2026-05-22T11:00:00.000Z';

type SlotData = Record<string, unknown>;

/** Рядок слота у формі, яку toDto() змапить: include-relations за замовчуванням null. */
function slotRow(over: SlotData): SlotData {
  return {
    id: SLOT_ID,
    orgId: ORG_ID,
    liftId: null,
    employeeId: null,
    workOrderId: null,
    counterpartyId: null,
    vehicleId: null,
    notes: null,
    status: 'BOOKED',
    type: 'WORK',
    parentSlotId: null,
    startAt: new Date(START_AT),
    endAt: new Date(END_AT),
    counterparty: null,
    vehicle: null,
    workOrder: null,
    ...over,
  };
}

/** Mock для createSlot: create() повертає те, що йому передали у data (плюс relations). */
function buildCreatePrisma(relations: SlotData = {}) {
  const create = vi
    .fn()
    .mockImplementation(async ({ data }: { data: SlotData }) => slotRow({ ...data, ...relations }));
  const probe = vi.fn().mockResolvedValue(null);
  return {
    lift: { findFirst: vi.fn().mockResolvedValue({ id: LIFT_ID, zone: { branchId: null } }) },
    employee: { findFirst: vi.fn().mockResolvedValue({ id: EMPLOYEE_ID }) },
    workOrder: { findFirst: vi.fn() },
    counterparty: { findFirst: vi.fn().mockResolvedValue({ id: COUNTERPARTY_ID }) },
    vehicle: { findFirst: vi.fn() },
    branchSettings: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi
      .fn()
      .mockImplementation(async (cb: (tx: unknown) => unknown) =>
        cb({ calendarSlot: { findFirst: probe, create } }),
      ),
    _create: create,
    _probe: probe,
  };
}

describe('CalendarService — види слотів (BR-CAL)', () => {
  // guards: BR-CAL-001
  it('counterpartyId без workOrderId → слот зберігає прямого клієнта, наряд лишається null', async () => {
    const prisma = buildCreatePrisma({
      counterparty: {
        firstName: 'Іван',
        lastName: 'Петренко',
        companyName: null,
        phone: '+380501112233',
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new CalendarService(prisma as any);

    const result = await service.createSlot(ORG_ID, {
      counterpartyId: COUNTERPARTY_ID,
      startAt: START_AT,
      endAt: END_AT,
    } as never);

    const data = prisma._create.mock.calls[0][0].data as SlotData;
    expect(data.counterpartyId).toBe(COUNTERPARTY_ID);
    expect(data.workOrderId).toBeNull();
    // Наряд не шукається взагалі; клієнт перевіряється у межах своєї org.
    expect(prisma.workOrder.findFirst).not.toHaveBeenCalled();
    expect(prisma.counterparty.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: COUNTERPARTY_ID, orgId: ORG_ID, deletedAt: null } }),
    );
    // У відповіді клієнт береться прямо зі слота (workOrder = null).
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0]).toMatchObject({
      counterpartyId: COUNTERPARTY_ID,
      workOrderId: null,
      cpPhone: '+380501112233',
    });
    expect(result.slots[0].counterpartyName).toContain('Петренко');
  });

  // guards: BR-CAL-002
  it('слот на підйомник без employeeId → створюється з employeeId=null, зайнятість механіка не перевіряється', async () => {
    const prisma = buildCreatePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new CalendarService(prisma as any);

    const result = await service.createSlot(ORG_ID, {
      liftId: LIFT_ID,
      startAt: START_AT,
      endAt: END_AT,
    } as never);

    const data = prisma._create.mock.calls[0][0].data as SlotData;
    expect(data.liftId).toBe(LIFT_ID);
    expect(data.employeeId).toBeNull();
    expect(prisma.employee.findFirst).not.toHaveBeenCalled();
    // Рівно одна conflict-проба — по підйомнику; проби по механіку немає.
    expect(prisma._probe).toHaveBeenCalledTimes(1);
    expect(prisma._probe.mock.calls[0][0].where).toMatchObject({ liftId: LIFT_ID });
    expect(prisma._probe.mock.calls[0][0].where).not.toHaveProperty('employeeId');
    expect(result.slots[0]).toMatchObject({ liftId: LIFT_ID, employeeId: null });
  });

  // guards: BR-CAL-002
  it('updateSlot з employeeId=null → знімає механіка зі слота, проба лишається тільки по підйомнику', async () => {
    const existing = slotRow({ liftId: LIFT_ID, employeeId: EMPLOYEE_ID });
    const probe = vi.fn().mockResolvedValue(null);
    const update = vi
      .fn()
      .mockImplementation(async ({ data }: { data: SlotData }) => ({ ...existing, ...data }));
    const prisma = {
      calendarSlot: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null) // hasContinuation
          .mockResolvedValueOnce(existing), // existing
      },
      lift: { findFirst: vi.fn() },
      employee: { findFirst: vi.fn() },
      workOrder: { findFirst: vi.fn() },
      counterparty: { findFirst: vi.fn() },
      vehicle: { findFirst: vi.fn() },
      $transaction: vi
        .fn()
        .mockImplementation(async (cb: (tx: unknown) => unknown) =>
          cb({ calendarSlot: { findFirst: probe, update } }),
        ),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new CalendarService(prisma as any);

    const result = await service.updateSlot(ORG_ID, SLOT_ID, { employeeId: null });

    const data = update.mock.calls[0][0].data as SlotData;
    expect(data).toHaveProperty('employeeId', null);
    expect(prisma.employee.findFirst).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0][0].where).toMatchObject({ liftId: LIFT_ID });
    expect(result).toMatchObject({ liftId: LIFT_ID, employeeId: null });
  });

  // guards: BR-CAL-003
  it.each(['MAINTENANCE', 'BREAK', 'MEETING'] as const)(
    'type=%s без наряду і без клієнта → слот створюється саме з цим типом',
    async type => {
      const prisma = buildCreatePrisma();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new CalendarService(prisma as any);

      const result = await service.createSlot(ORG_ID, {
        liftId: LIFT_ID,
        type,
        startAt: START_AT,
        endAt: END_AT,
      } as never);

      const data = prisma._create.mock.calls[0][0].data as SlotData;
      expect(data.type).toBe(type);
      expect(data.workOrderId).toBeNull();
      expect(data.counterpartyId).toBeNull();
      expect(prisma.workOrder.findFirst).not.toHaveBeenCalled();
      expect(prisma.counterparty.findFirst).not.toHaveBeenCalled();
      expect(result.slots[0]).toMatchObject({ type, workOrderId: null, counterpartyId: null });
    },
  );
});
