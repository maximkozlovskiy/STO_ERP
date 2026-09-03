import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkOrdersService } from './work-orders.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { WorkOrderQueryDto } from './work-orders.dto';

// ─── Query-shape regression spec (Bug #163 / #171 pattern) ────────────────────
//
// The contract spec mocks the whole WorkOrdersService (`useValue: serviceMock`),
// so it NEVER executes the real `findAll` Prisma query — a regression in the
// `calendarSlots` relation name (plural→singular), the `take: 1` cap, the soft-delete
// filter, or the nested counterparty search relations would pass every test and
// only blow up at runtime as a PrismaClientValidationError.
//
// This spec drives the REAL findAll against a Prisma mock-spy and asserts the
// exact `findMany`/`count` argument shape that the calendar "next slot" badge and
// the `?q=` search depend on.

const ORG = '11111111-1111-4111-8111-111111111111';

function makePrismaSpy() {
  const findMany = vi.fn().mockResolvedValue([]);
  const count = vi.fn().mockResolvedValue(0);
  const prisma = {
    workOrder: { findMany, count },
    // findAll wraps the two reads in `$transaction([...])` (array form) — execute the array.
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  } as unknown as PrismaService;
  return { prisma, findMany, count };
}

function makeService(prisma: PrismaService): WorkOrdersService {
  // findAll only touches `this.prisma`; the other 9 deps are unused on this path.
  return new WorkOrdersService(
    prisma,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );
}

const baseQuery: WorkOrderQueryDto = { page: 1, limit: 20 } as WorkOrderQueryDto;

describe('WorkOrdersService.findAll — query shape', () => {
  let prisma: PrismaService;
  let findMany: ReturnType<typeof vi.fn>;
  let count: ReturnType<typeof vi.fn>;
  let service: WorkOrdersService;

  beforeEach(() => {
    ({ prisma, findMany, count } = makePrismaSpy());
    service = makeService(prisma);
  });

  it('includes calendarSlots with the correct relation name, soft-delete filter, asc order and take:1', async () => {
    await service.findAll(ORG, baseQuery);

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0];

    // Relation name MUST be the plural `calendarSlots` (matches Prisma WorkOrder.calendarSlots).
    // Guard against a regression back to a singular/renamed relation → PrismaClientValidationError.
    expect(arg.include).toHaveProperty('calendarSlots');
    expect(arg.include).not.toHaveProperty('calendarSlot');

    const slots = arg.include.calendarSlots;
    expect(slots.where).toEqual({ deletedAt: null }); // only live slots feed the badge
    expect(slots.orderBy).toEqual({ startAt: 'asc' }); // earliest slot first
    expect(slots.take).toBe(1); // single round-trip — never load the whole history
    expect(slots.select).toMatchObject({
      startAt: true,
      endAt: true,
      lift: { select: { name: true } },
    });
  });

  it('scopes to org and excludes soft-deleted work orders by default', async () => {
    await service.findAll(ORG, baseQuery);
    const where = findMany.mock.calls[0][0].where;
    expect(where.orgId).toBe(ORG);
    expect(where.deletedAt).toBeNull();
    // count() must use the SAME where (pagination total stays consistent with the page)
    expect(count.mock.calls[0][0].where).toEqual(where);
  });

  it('?q= search targets number + nested counterparty relations (insensitive)', async () => {
    await service.findAll(ORG, { ...baseQuery, q: 'AB-1' } as WorkOrderQueryDto);
    const or = findMany.mock.calls[0][0].where.OR;
    expect(Array.isArray(or)).toBe(true);
    expect(or).toContainEqual({ number: { contains: 'AB-1', mode: 'insensitive' } });
    // Nested counterparty relations must be addressed by the real relation key.
    expect(or).toContainEqual({
      counterparty: { companyName: { contains: 'AB-1', mode: 'insensitive' } },
    });
    expect(or).toContainEqual({
      counterparty: { lastName: { contains: 'AB-1', mode: 'insensitive' } },
    });
    expect(or).toContainEqual({
      counterparty: { firstName: { contains: 'AB-1', mode: 'insensitive' } },
    });
  });

  it('employeeId filter uses a soft-delete-aware `some` correlated subquery on lines', async () => {
    const empId = '22222222-2222-4222-8222-222222222222';
    await service.findAll(ORG, { ...baseQuery, employeeId: empId } as WorkOrderQueryDto);
    const where = findMany.mock.calls[0][0].where;
    expect(where.lines).toEqual({ some: { employeeId: empId, deletedAt: null } });
  });
});

// ─── update() query-shape regression spec (Bug #350 follow-up) ─────────────────
//
// PATCH /work-orders/:id response feeds frontend WorkOrderDetail. After the
// follow-up fix that added `include.contract` so PATCH carries `contractNumber`,
// guard against future regression where someone removes the include during
// refactor — Bug #232 pattern (include audit). Without `contract` in the
// include, every PATCH of description/mileage/priority would silently null-out
// the contract row in the detail UI even when contractId stays the same.

// HIGH (audit 2026-09-04): concurrent transition(COMPLETED) давав подвійний CHARGE (баланс ×2).
// Fix — re-read статусу В $transaction; якщо змінився між pre-tx read і tx → throw (не виконує
// side-effects повторно). Тест доводить, що вікно закрите: коли in-tx read бачить інший статус.
describe('WorkOrdersService.transition — in-tx status re-read guard (double-CHARGE)', () => {
  const WO_ID = '44444444-4444-4444-8444-444444444444';

  it('статус змінився між pre-tx read і tx → throw, side-effects НЕ виконуються повторно', async () => {
    const findFirst = vi
      .fn()
      // 1) pre-tx read — наряд ще IN_PROGRESS (проходить FSM-check IN_PROGRESS→COMPLETED)
      .mockResolvedValueOnce({
        id: WO_ID,
        orgId: ORG,
        status: 'IN_PROGRESS',
        number: 'WO-9',
        outMileage: null,
        vehicleId: 'v',
        repairCategory: null,
        counterpartyId: 'c',
        totalAmount: 1000,
      })
      // 2) in-tx guard read — інший конкурентний виклик уже перевів у COMPLETED
      .mockResolvedValueOnce({ status: 'COMPLETED' });
    const update = vi.fn();
    const prisma = {
      workOrder: { findFirst, update },
      $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(prisma)),
    } as unknown as PrismaService;
    const service = makeService(prisma);

    await expect(service.transition(ORG, WO_ID, 'COMPLETED' as never)).rejects.toThrow(
      /Статус наряду змінився/,
    );
    // update НЕ викликано — guard спрацював до фінального write і до writeOffPartsAndCharge.
    expect(update).not.toHaveBeenCalled();
  });
});

describe('WorkOrdersService.update — query shape (Bug #350 follow-up)', () => {
  const WO_ID = '33333333-3333-4333-8333-333333333333';

  function makeUpdatePrisma() {
    const findFirst = vi.fn().mockResolvedValue({
      id: WO_ID,
      orgId: ORG,
      status: 'DRAFT',
      description: 'old',
    });
    const update = vi.fn().mockResolvedValue({
      id: WO_ID,
      orgId: ORG,
      number: 'WO-1',
      status: 'DRAFT',
      priority: 'NORMAL',
      repairCategory: null,
      branchId: 'b',
      branch: { name: 'Br' },
      vehicleId: 'v',
      vehicle: { make: 'X', model: 'Y', licensePlate: 'AB1234' },
      counterpartyId: 'c',
      counterparty: { firstName: 'Іван', lastName: 'Петров', companyName: null },
      contractId: 'con-1',
      contract: { id: 'con-1', number: 'ДГ-2026-000001' },
      description: 'new',
      inMileage: null,
      outMileage: null,
      plannedAt: null,
      dueDate: null,
      completedAt: null,
      warrantyUntil: null,
      clientApproval: false,
      totalLabor: 0,
      totalParts: 0,
      totalAmount: 0,
      paidAmount: 0,
      documentDate: new Date('2026-06-04'),
      syncVersion: 0n,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
    const prisma = {
      workOrder: { findFirst, update },
    } as unknown as PrismaService;
    return { prisma, findFirst, update };
  }

  it('include carries contract { id, number } so toDto can map contractNumber', async () => {
    const { prisma, update } = makeUpdatePrisma();
    const service = makeService(prisma);

    // Bug #350 follow-up regression-guard: PATCH must include `contract` relation,
    // otherwise WorkOrderDetail.contractNumber goes null after every save.
    await service.update(ORG, WO_ID, { description: 'new' });

    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0][0];

    // include MUST have all 4 relations
    expect(arg.include).toHaveProperty('contract');
    expect(arg.include).toHaveProperty('vehicle');
    expect(arg.include).toHaveProperty('counterparty');
    expect(arg.include).toHaveProperty('branch');

    // contract select shape — only what toDto reads (id + number); guard against
    // accidental `contract: true` which leaks contractType/dates and grows payload.
    expect(arg.include.contract).toEqual({ select: { id: true, number: true } });
  });

  it('update scopes write to tenant via where.orgId (defense-in-depth)', async () => {
    const { prisma, update } = makeUpdatePrisma();
    const service = makeService(prisma);

    await service.update(ORG, WO_ID, { description: 'new' });
    const arg = update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: WO_ID, orgId: ORG });
  });

  it('returned dto carries contractNumber from the included contract.number', async () => {
    const { prisma } = makeUpdatePrisma();
    const service = makeService(prisma);

    const result = await service.update(ORG, WO_ID, { description: 'new' });
    expect(result.contractNumber).toBe('ДГ-2026-000001');
    expect(result.contractId).toBe('con-1');
  });

  // ─── Bug #426 (regression-guard) ────────────────────────────────────────────
  //
  // fa3b3ad8 додав plannedHours/actualHours у WorkOrder schema/DTO. update()
  // персистить ОБИДВА (line 429-430), audit диф включає ОБИДВА (line 399-400).
  // Цей блок ловить три можливі регресії:
  //   1. update() data spread випадково видаляє plannedHours/actualHours →
  //      PATCH мовчки ігнорує поле (frontend бачить старе значення).
  //   2. audit trackField забуває нові поля → AuditEvent.diff не містить
  //      зміни нормогодин (тихий пропуск, видно лише при ручній перевірці).
  //   3. nullable handling: { plannedHours: null } має CLEAR поле (Prisma null),
  //      а { plannedHours: undefined } — skip. Регресія на ternary = silent data loss.

  it('update() persists plannedHours/actualHours with explicit null-vs-undefined semantics', async () => {
    const { prisma, update } = makeUpdatePrisma();
    const service = makeService(prisma);

    // Case 1: numeric value passes through unchanged
    await service.update(ORG, WO_ID, { plannedHours: 2.5, actualHours: 1.75 });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].data).toMatchObject({
      plannedHours: 2.5,
      actualHours: 1.75,
    });

    // Case 2: explicit null clears the field (frontend reset)
    update.mockClear();
    await service.update(ORG, WO_ID, {
      plannedHours: null as unknown as number | undefined,
      actualHours: null as unknown as number | undefined,
    });
    expect(update.mock.calls[0][0].data).toMatchObject({
      plannedHours: null,
      actualHours: null,
    });

    // Case 3: undefined (omit) skips write — no key in data
    update.mockClear();
    await service.update(ORG, WO_ID, { description: 'just description' });
    const data = update.mock.calls[0][0].data;
    expect(data.plannedHours).toBeUndefined();
    expect(data.actualHours).toBeUndefined();
  });
});

// ─── writeOffPartsAndCharge — batchCostPrice/batchId writeback ───────────────
//
// Bug #609 regression-guard: після commit 19f81ccb (feat/inventory FIFO+COGS підключення)
// COMPLETED-transition наряду викликає inventory.createMovement(WRITEOFF) для кожної
// запчастини, отримує { consumed, weightedCostPrice } і записує:
//   WorkOrderPart.batchCostPrice = weightedCostPrice  (для звіту рентабельності)
//   WorkOrderPart.batchId        = consumed[0].batchId коли consumed.length===1, інакше NULL
//
// Без цього тесту рефактор який видалить update workOrderPart блок пройде CI зеленим —
// runtime баг: звіт рентабельності показує NULL cost, маржа неточна.
describe('WorkOrdersService.writeOffPartsAndCharge — batchCostPrice/batchId writeback', () => {
  const WO_ID = '11111111-1111-4111-8111-111111111111';
  const PART1_ID = '22222222-2222-4222-8222-222222222222';
  const PART2_ID = '33333333-3333-4333-8333-333333333333';
  const GOOD_ID = '44444444-4444-4444-8444-444444444444';
  const WH_ID = '55555555-5555-4555-8555-555555555555';
  const BATCH1_ID = '66666666-6666-4666-8666-666666666666';

  function makeSvc(
    inventoryCreateMovement: ReturnType<typeof vi.fn>,
    partsToProcess: Array<{ id: string; quantity: number }>,
    partUpdate: ReturnType<typeof vi.fn>,
  ): WorkOrdersService {
    const prisma = {
      workOrderPart: {
        findMany: vi.fn().mockResolvedValue(
          partsToProcess.map(p => ({
            id: p.id,
            goodId: GOOD_ID,
            warehouseId: WH_ID,
            quantity: p.quantity,
            unitOfMeasureId: null,
          })),
        ),
        update: partUpdate,
      },
      goodUoM: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const inventory = { createMovement: inventoryCreateMovement } as unknown as InstanceType<
      typeof WorkOrdersService
    >['inventory'];
    const settlements = { createTransaction: vi.fn() } as unknown as InstanceType<
      typeof WorkOrdersService
    >['settlements'];
    // Constructor: prisma, inventory, settlements, notifications, docNumbers,
    //   maintenanceSchedules, pdf, audit, warranties, settingsService, config
    return new WorkOrdersService(
      prisma,
      inventory,
      settlements,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
    );
  }

  it('single-batch WRITEOFF → part.batchCostPrice + part.batchId проставляються', async () => {
    const partUpdate = vi.fn().mockResolvedValue({});
    const createMovement = vi.fn().mockImplementation((_, dto) => {
      if (dto.type === 'RESERVATION_RELEASE') {
        return Promise.resolve({ movementId: 'm-rel', consumed: [], weightedCostPrice: null });
      }
      // WRITEOFF single batch
      return Promise.resolve({
        movementId: 'm-wo',
        consumed: [{ batchId: BATCH1_ID, quantity: 2, costPrice: 120 }],
        weightedCostPrice: 120,
      });
    });
    const svc = makeSvc(createMovement, [{ id: PART1_ID, quantity: 2 }], partUpdate);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).writeOffPartsAndCharge(
      'org-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: WO_ID, counterpartyId: 'cp-1', totalAmount: 500 as any },
      'user-1',
      undefined,
    );
    expect(partUpdate).toHaveBeenCalledTimes(1);
    expect(partUpdate.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        where: { id: PART1_ID },
        data: { batchCostPrice: 120, batchId: BATCH1_ID },
      }),
    );
  });

  it('span >1 batch → batchCostPrice=weighted, batchId=NULL (нема єдиного джерела)', async () => {
    const partUpdate = vi.fn().mockResolvedValue({});
    const createMovement = vi.fn().mockImplementation((_, dto) => {
      if (dto.type === 'RESERVATION_RELEASE') {
        return Promise.resolve({ movementId: 'm-rel', consumed: [], weightedCostPrice: null });
      }
      return Promise.resolve({
        movementId: 'm-wo',
        consumed: [
          { batchId: BATCH1_ID, quantity: 3, costPrice: 100 },
          { batchId: 'other-batch', quantity: 2, costPrice: 200 },
        ],
        weightedCostPrice: (3 * 100 + 2 * 200) / 5, // 140
      });
    });
    const svc = makeSvc(createMovement, [{ id: PART1_ID, quantity: 5 }], partUpdate);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).writeOffPartsAndCharge(
      'org-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: WO_ID, counterpartyId: 'cp-1', totalAmount: 500 as any },
      'user-1',
      undefined,
    );
    expect(partUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PART1_ID },
        data: { batchCostPrice: 140, batchId: null },
      }),
    );
  });

  // Regression-guard: AVG_COST у InventoryService повертає consumed=[{batchId: null, ...}]
  // (агрегат — не одна партія). `batchId: consumed.length===1 ? consumed[0].batchId : null`
  // → null напряму лягає у nullable WorkOrderPart.batchId :: uuid (порожній рядок раніше
  // пробивав "invalid input syntax for type uuid" → FSM COMPLETED падав на всіх org з
  // costMethod=AVG_COST). COGS (batchCostPrice) зберігається, посилання на партію — ні.
  it('AVG_COST агрегат batchId=null → part.batchId=null, batchCostPrice зберігається', async () => {
    const partUpdate = vi.fn().mockResolvedValue({});
    const createMovement = vi.fn().mockImplementation((_, dto) => {
      if (dto.type === 'RESERVATION_RELEASE') {
        return Promise.resolve({ movementId: 'm-rel', consumed: [], weightedCostPrice: null });
      }
      return Promise.resolve({
        movementId: 'm-wo',
        consumed: [{ batchId: null, quantity: 2, costPrice: 130 }],
        weightedCostPrice: 130,
      });
    });
    const svc = makeSvc(createMovement, [{ id: PART1_ID, quantity: 2 }], partUpdate);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).writeOffPartsAndCharge(
      'org-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: WO_ID, counterpartyId: 'cp-1', totalAmount: 500 as any },
      'user-1',
      undefined,
    );
    expect(partUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PART1_ID },
        data: { batchCostPrice: 130, batchId: null },
      }),
    );
  });

  it('weightedCostPrice=null → workOrderPart.update НЕ викликається (не перезаписує NULL)', async () => {
    const partUpdate = vi.fn().mockResolvedValue({});
    const createMovement = vi.fn().mockImplementation((_, dto) => {
      if (dto.type === 'RESERVATION_RELEASE') {
        return Promise.resolve({ movementId: 'm-rel', consumed: [], weightedCostPrice: null });
      }
      return Promise.resolve({
        movementId: 'm-wo',
        consumed: [],
        weightedCostPrice: null,
      });
    });
    const svc = makeSvc(createMovement, [{ id: PART1_ID, quantity: 2 }], partUpdate);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).writeOffPartsAndCharge(
      'org-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: WO_ID, counterpartyId: 'cp-1', totalAmount: 500 as any },
      'user-1',
      undefined,
    );
    expect(partUpdate).not.toHaveBeenCalled();
  });

  it('multiple parts → кожен отримує окремий update із власним batchCostPrice', async () => {
    const partUpdate = vi.fn().mockResolvedValue({});
    const createMovement = vi.fn().mockImplementation((_, dto) => {
      if (dto.type === 'RESERVATION_RELEASE') {
        return Promise.resolve({ movementId: 'm-rel', consumed: [], weightedCostPrice: null });
      }
      // Різні cost для різних partId
      const cost = dto.documentLineId === PART1_ID ? 100 : 250;
      return Promise.resolve({
        movementId: 'm-wo',
        consumed: [{ batchId: BATCH1_ID, quantity: dto.quantity * -1, costPrice: cost }],
        weightedCostPrice: cost,
      });
    });
    const svc = makeSvc(
      createMovement,
      [
        { id: PART1_ID, quantity: 2 },
        { id: PART2_ID, quantity: 1 },
      ],
      partUpdate,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).writeOffPartsAndCharge(
      'org-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: WO_ID, counterpartyId: 'cp-1', totalAmount: 500 as any },
      'user-1',
      undefined,
    );
    expect(partUpdate).toHaveBeenCalledTimes(2);
    const call1 = partUpdate.mock.calls.find(c => c[0].where.id === PART1_ID);
    const call2 = partUpdate.mock.calls.find(c => c[0].where.id === PART2_ID);
    expect(call1?.[0].data.batchCostPrice).toBe(100);
    expect(call2?.[0].data.batchCostPrice).toBe(250);
  });

  it('WRITEOFF не передає price (собівартість береться з партій, не з price ЯКА ЄЦІНА ПРОДАЖУ)', async () => {
    const partUpdate = vi.fn().mockResolvedValue({});
    const createMovement = vi.fn().mockImplementation((_, dto) => {
      if (dto.type === 'RESERVATION_RELEASE') {
        return Promise.resolve({ movementId: 'm-rel', consumed: [], weightedCostPrice: null });
      }
      return Promise.resolve({
        movementId: 'm-wo',
        consumed: [{ batchId: BATCH1_ID, quantity: 2, costPrice: 100 }],
        weightedCostPrice: 100,
      });
    });
    const svc = makeSvc(createMovement, [{ id: PART1_ID, quantity: 2 }], partUpdate);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).writeOffPartsAndCharge(
      'org-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: WO_ID, counterpartyId: 'cp-1', totalAmount: 500 as any },
      'user-1',
      undefined,
    );
    // WRITEOFF DTO не має ключа price (собівартість береться з партій)
    const wo = createMovement.mock.calls.find(c => c[1].type === 'WRITEOFF');
    expect(wo?.[1]).not.toHaveProperty('price');
    // documentLineId = part.id (для BatchConsumption trace)
    expect(wo?.[1].documentLineId).toBe(PART1_ID);
  });
});
