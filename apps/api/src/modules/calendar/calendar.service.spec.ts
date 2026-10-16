import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { matchesWhere } from './calendar.spec-fixture';

// Lightweight regression-guard tests for syncWorkOrderSlots:
// 1. soft-delete continuation children before updating parent (Bug #review-7640de gotcha)
// 2. tenant-isolation guard rejects cross-tenant workOrderId (Bug #442)
// 3. endAt <= startAt rejected (#review-7640de)

describe('CalendarService.syncWorkOrderSlots', () => {
  const orgId = 'org-1';
  const workOrderId = '11111111-1111-4111-8111-111111111111';

  // Минимальний mock prisma тільки для $transaction + потрібних query-методів.
  function buildPrismaMock(opts: {
    workOrderExists?: boolean;
    updatedCount?: number;
    parentSlot?: { id: string; liftId: string | null; employeeId: string | null } | null;
    conflictingSlot?: { id: string; liftId: string | null; employeeId: string | null } | null;
  }) {
    const updateMany = vi.fn();
    // Both updateMany calls inside $transaction — soft-delete continuation + update parent.
    // sto-optimize: run in Promise.all (parallel) but mock returns are queued the same way.
    updateMany.mockResolvedValueOnce({ count: 0 });
    updateMany.mockResolvedValueOnce({ count: opts.updatedCount ?? 1 });

    // findFirst within $transaction:
    //   1) parentSlot lookup on calendarSlot
    //   2) conflict probe on calendarSlot (only when parentSlot has lift/employee)
    const findFirst = vi.fn();
    findFirst.mockResolvedValueOnce(opts.parentSlot ?? null); // parent slot lookup
    if (opts.parentSlot) {
      findFirst.mockResolvedValueOnce(opts.conflictingSlot ?? null); // conflict probe
    }

    const txCalendarSlot = { updateMany, findFirst };
    // sto-optimize: tenant guard moved INSIDE $transaction для parallel виконання з parentSlot.
    // Mock tx.workOrder.findFirst тепер потрібен (не prisma.workOrder.findFirst).
    const txWorkOrderFindFirst = vi
      .fn()
      .mockResolvedValue(opts.workOrderExists === false ? null : { id: workOrderId });

    return {
      // Legacy: deprecated outside-tx path. Залишаємо stub щоб старі асерти не падали з undefined.
      workOrder: { findFirst: vi.fn() },
      $transaction: vi
        .fn()
        .mockImplementation(async cb =>
          cb({ calendarSlot: txCalendarSlot, workOrder: { findFirst: txWorkOrderFindFirst } }),
        ),
      _txCalendarSlot: txCalendarSlot,
      _txWorkOrderFindFirst: txWorkOrderFindFirst,
    };
  }

  it('кидає 400 коли endAt <= startAt', async () => {
    const prisma = buildPrismaMock({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new CalendarService(prisma as any);
    await expect(
      service.syncWorkOrderSlots(orgId, workOrderId, {
        startAt: '2026-05-22T11:00:00.000Z',
        endAt: '2026-05-22T10:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Жодного запиту до DB не повинно бути — перевірка до $transaction.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma._txWorkOrderFindFirst).not.toHaveBeenCalled();
  });

  it('кидає 400 коли startAt/endAt не парсяться у валідну Date', async () => {
    const prisma = buildPrismaMock({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new CalendarService(prisma as any);
    await expect(
      service.syncWorkOrderSlots(orgId, workOrderId, {
        startAt: 'invalid-date',
        endAt: 'also-invalid',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('кидає 404 коли наряд не існує / належить іншій org (Bug #442 tenant guard)', async () => {
    const prisma = buildPrismaMock({ workOrderExists: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new CalendarService(prisma as any);
    await expect(
      service.syncWorkOrderSlots(orgId, workOrderId, {
        startAt: '2026-05-22T10:00:00.000Z',
        endAt: '2026-05-22T11:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    // sto-optimize: tenant guard now runs inside $transaction in parallel з parentSlot.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma._txWorkOrderFindFirst).toHaveBeenCalledWith({
      where: { id: workOrderId, orgId, deletedAt: null },
      select: { id: true },
    });
    // updateMany не повинен запуститися — 404 throw скасовує tx.
    expect(prisma._txCalendarSlot.updateMany).not.toHaveBeenCalled();
  });

  it('у $transaction робить soft-delete continuation FIRST, потім update parent (Gotcha #review-7640de)', async () => {
    const prisma = buildPrismaMock({ updatedCount: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new CalendarService(prisma as any);
    const result = await service.syncWorkOrderSlots(orgId, workOrderId, {
      startAt: '2026-05-22T10:00:00.000Z',
      endAt: '2026-05-22T11:00:00.000Z',
    });
    expect(result).toEqual({ updated: 1 });
    expect(prisma._txCalendarSlot.updateMany).toHaveBeenCalledTimes(2);

    // Call #1: soft-delete continuation children (parentSlotId IS NOT NULL).
    const call1Args = prisma._txCalendarSlot.updateMany.mock.calls[0][0];
    expect(call1Args.where).toMatchObject({
      orgId,
      workOrderId,
      parentSlotId: { not: null },
      deletedAt: null,
    });
    expect(call1Args.data.deletedAt).toBeInstanceOf(Date);

    // Call #2: update parent only (parentSlotId === null).
    const call2Args = prisma._txCalendarSlot.updateMany.mock.calls[1][0];
    expect(call2Args.where).toMatchObject({
      orgId,
      workOrderId,
      parentSlotId: null,
      deletedAt: null,
    });
    expect(call2Args.data.startAt).toBeInstanceOf(Date);
    expect(call2Args.data.endAt).toBeInstanceOf(Date);
  });

  it('повертає { updated: 0 } коли parent slot не існує (no-op)', async () => {
    const prisma = buildPrismaMock({ updatedCount: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new CalendarService(prisma as any);
    const result = await service.syncWorkOrderSlots(orgId, workOrderId, {
      startAt: '2026-05-22T10:00:00.000Z',
      endAt: '2026-05-22T11:00:00.000Z',
    });
    expect(result).toEqual({ updated: 0 });
  });

  // CAL-C2 regression-guard: findSlots must use half-open OVERLAP, not CONTAINMENT.
  // Containment (`startAt>=dayStart AND endAt<=dayEnd`) silently drops slots that cross the
  // day boundary (split-day continuation from the previous evening, or a slot straddling
  // midnight) → the calendar shows a lift as free while it is actually occupied.
  describe('findSlots — CAL-C2 overlap (not containment)', () => {
    it('запитує слоти через half-open OVERLAP (startAt<end AND endAt>start), не CONTAINMENT', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const prisma = { calendarSlot: { findMany } };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new CalendarService(prisma as any);

      await service.findSlots('org-1', '2026-06-15', 'ADMIN');

      expect(findMany).toHaveBeenCalledTimes(1);
      const where = findMany.mock.calls[0][0].where;
      // OVERLAP: startAt is bounded from ABOVE (lt), endAt from BELOW (gt).
      expect(where.startAt).toHaveProperty('lt');
      expect(where.endAt).toHaveProperty('gt');
      // Regression: NOT the old containment shape.
      expect(where.startAt).not.toHaveProperty('gte');
      expect(where.endAt).not.toHaveProperty('lte');
    });

    it('MECHANIC гілка теж використовує OVERLAP where', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const prisma = { calendarSlot: { findMany } };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new CalendarService(prisma as any);

      await service.findSlots('org-1', '2026-06-15', 'MECHANIC');

      const where = findMany.mock.calls[0][0].where;
      expect(where.startAt).toHaveProperty('lt');
      expect(where.endAt).toHaveProperty('gt');
    });
  });

  // Bug #444 regression-guard: alternate-mutation endpoint (syncWorkOrderSlots)
  // має повторити conflict check що робить canonical createSlot()/updateSlot().
  // Інакше move planned hours може silently overlap слот іншого наряду на тому
  // самому lift/employee → double-booking, broken capacity invariant.
  // SKILL §1.1 «Alternate-mutation endpoint обходить canonical guards» (#403).
  describe('Bug #444 — conflict check vs OTHER WO slots', () => {
    const liftId = '22222222-2222-4222-8222-222222222222';
    const employeeId = '33333333-3333-4333-8333-333333333333';

    // guards: BR-CAL-005
    it('кидає 400 «Підйомник вже зайнятий» коли парент-слот перетинається з іншим WO на тому ж lift', async () => {
      const prisma = buildPrismaMock({
        parentSlot: { id: 'parent-1', liftId, employeeId: null },
        conflictingSlot: { id: 'other-slot', liftId, employeeId: null },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new CalendarService(prisma as any);
      await expect(
        service.syncWorkOrderSlots(orgId, workOrderId, {
          startAt: '2026-05-22T10:00:00.000Z',
          endAt: '2026-05-22T11:00:00.000Z',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // updateMany має НЕ запускатися — конфлікт кидається до зміни даних.
      expect(prisma._txCalendarSlot.updateMany).not.toHaveBeenCalled();
    });

    // guards: BR-CAL-005
    it('кидає 400 «Співробітник вже зайнятий» коли парент-слот перетинається з іншим WO на тому ж employee', async () => {
      const prisma = buildPrismaMock({
        parentSlot: { id: 'parent-1', liftId: null, employeeId },
        conflictingSlot: { id: 'other-slot', liftId: null, employeeId },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new CalendarService(prisma as any);
      await expect(
        service.syncWorkOrderSlots(orgId, workOrderId, {
          startAt: '2026-05-22T10:00:00.000Z',
          endAt: '2026-05-22T11:00:00.000Z',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma._txCalendarSlot.updateMany).not.toHaveBeenCalled();
    });

    // guards: BR-CAL-005
    it('conflict probe шукає ЧУЖІ слоти (workOrderId ≠ свій) у half-open перетині на lift АБО employee парента', async () => {
      const prisma = buildPrismaMock({
        parentSlot: { id: 'parent-1', liftId, employeeId },
        conflictingSlot: null,
        updatedCount: 1,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new CalendarService(prisma as any);
      await service.syncWorkOrderSlots(orgId, workOrderId, {
        startAt: '2026-05-22T10:00:00.000Z',
        endAt: '2026-05-22T11:00:00.000Z',
      });
      // findFirst #1 — parent lookup, #2 — conflict probe.
      expect(prisma._txCalendarSlot.findFirst).toHaveBeenCalledTimes(2);
      const where = prisma._txCalendarSlot.findFirst.mock.calls[1][0].where;
      expect(where).toEqual({
        orgId,
        deletedAt: null,
        workOrderId: { not: workOrderId },
        AND: [{ OR: [{ workOrderId: null }, { workOrder: { is: { deletedAt: null } } }] }],
        startAt: { lt: new Date('2026-05-22T11:00:00.000Z') },
        endAt: { gt: new Date('2026-05-22T10:00:00.000Z') },
        OR: [{ liftId }, { employeeId }],
      });
    });

    it('пропускає conflict check коли parent slot без lift/employee (немає що бронювати)', async () => {
      const prisma = buildPrismaMock({
        parentSlot: { id: 'parent-1', liftId: null, employeeId: null },
        updatedCount: 1,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new CalendarService(prisma as any);
      const result = await service.syncWorkOrderSlots(orgId, workOrderId, {
        startAt: '2026-05-22T10:00:00.000Z',
        endAt: '2026-05-22T11:00:00.000Z',
      });
      expect(result).toEqual({ updated: 1 });
      // Тільки один findFirst (parentSlot lookup) — conflict probe пропущений.
      expect(prisma._txCalendarSlot.findFirst).toHaveBeenCalledTimes(1);
    });

    // Bug #628 regression-guard: syncWorkOrderSlots (alternate-mutation endpoint) UPDATE-ить
    // startAt/endAt парент-слота — це перевіряється EXCLUDE-констрейнтом так само як INSERT.
    // Concurrent race, що обійшов app-probe (findFirst на stale-snapshot), ловиться DB → 23P01.
    // createSlot()/updateSlot() конвертують це у 409, а sync раніше пропускав → generic 500.
    it('Bug #628: конвертує EXCLUDE-порушення (23P01) на UPDATE парента у 409 ConflictException', async () => {
      const prisma = buildPrismaMock({
        parentSlot: { id: 'parent-1', liftId, employeeId: null },
        conflictingSlot: null, // app-probe пропускає (stale snapshot) — DB ловить
        updatedCount: 1,
      });
      // $transaction кидає raw 23P01 (як Postgres при UPDATE у пересічний інтервал).
      const exclusionErr = new Error(
        'exclusion_violation ... constraint "calendar_slots_no_overlap" ... SQLSTATE 23P01',
      );
      prisma.$transaction = vi.fn().mockRejectedValue(exclusionErr);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new CalendarService(prisma as any);
      await expect(
        service.syncWorkOrderSlots(orgId, workOrderId, {
          startAt: '2026-05-22T10:00:00.000Z',
          endAt: '2026-05-22T11:00:00.000Z',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('Bug #628: не-exclusion помилка пробрасується as-is (не маскується під 409)', async () => {
      const prisma = buildPrismaMock({
        parentSlot: { id: 'parent-1', liftId, employeeId: null },
        conflictingSlot: null,
        updatedCount: 1,
      });
      const otherErr = new Error('connection reset');
      prisma.$transaction = vi.fn().mockRejectedValue(otherErr);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new CalendarService(prisma as any);
      await expect(
        service.syncWorkOrderSlots(orgId, workOrderId, {
          startAt: '2026-05-22T10:00:00.000Z',
          endAt: '2026-05-22T11:00:00.000Z',
        }),
      ).rejects.toThrow('connection reset');
    });

    it('успішно оновлює коли немає конфлікту (default mock)', async () => {
      const prisma = buildPrismaMock({
        parentSlot: { id: 'parent-1', liftId, employeeId: null },
        conflictingSlot: null,
        updatedCount: 1,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new CalendarService(prisma as any);
      const result = await service.syncWorkOrderSlots(orgId, workOrderId, {
        startAt: '2026-05-22T10:00:00.000Z',
        endAt: '2026-05-22T11:00:00.000Z',
      });
      expect(result).toEqual({ updated: 1 });
      expect(prisma._txCalendarSlot.updateMany).toHaveBeenCalledTimes(2);
    });
  });

  // §13 config-over-hardcode: createSlot розбиває слот на межі робочого дня філії
  // (BranchSettings.workEndTime), а не хардкод 20:00.
  describe('createSlot — межі робочого дня per-branch (§13)', () => {
    const liftId = '22222222-2222-4222-8222-222222222222';
    const branchId = '33333333-3333-4333-8333-333333333333';

    // Мінімальний slot-row що toDto() коректно змапить (усі include-relations = null).
    const slotRow = (over: Record<string, unknown>) => ({
      id: 'slot-x',
      orgId,
      liftId,
      employeeId: null,
      workOrderId: null,
      counterpartyId: null,
      vehicleId: null,
      notes: null,
      status: 'BOOKED',
      type: 'WORK',
      parentSlotId: null,
      counterparty: null,
      vehicle: null,
      workOrder: null,
      ...over,
    });

    function buildCreateMock(workEndTime: string) {
      const create = vi
        .fn()
        .mockImplementation(async ({ data }: { data: { endAt: Date } }) =>
          slotRow({ startAt: new Date(), endAt: data.endAt }),
        );
      return {
        lift: {
          findFirst: vi.fn().mockResolvedValue({ id: liftId, zone: { branchId } }),
        },
        employee: { findFirst: vi.fn() },
        workOrder: { findFirst: vi.fn() },
        counterparty: { findFirst: vi.fn() },
        vehicle: { findFirst: vi.fn() },
        branchSettings: {
          findFirst: vi.fn().mockResolvedValue({ workStartTime: '09:00', workEndTime }),
        },
        $transaction: vi
          .fn()
          .mockImplementation(async (cb: (tx: unknown) => unknown) =>
            cb({ calendarSlot: { findFirst: vi.fn().mockResolvedValue(null), create } }),
          ),
        _create: create,
      };
    }

    it('workEndTime="18:00" → слот 16:00–19:00 Kyiv РОЗБИВАЄТЬСЯ на межі 18:00 (не 20:00)', async () => {
      const prisma = buildCreateMock('18:00');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new CalendarService(prisma as any);
      // Травень → DST +03:00: 16:00 Kyiv = 13:00Z, 19:00 Kyiv = 16:00Z.
      const result = await service.createSlot(orgId, {
        liftId,
        startAt: '2026-05-22T13:00:00.000Z',
        endAt: '2026-05-22T16:00:00.000Z',
      } as never);
      // 2 створення (split), бо 19:00 > 18:00 workEnd.
      expect(prisma._create).toHaveBeenCalledTimes(2);
      // slot1.endAt = 18:00 Kyiv = 15:00Z.
      const firstEnd = prisma._create.mock.calls[0][0].data.endAt as Date;
      expect(firstEnd.toISOString()).toBe('2026-05-22T15:00:00.000Z');
      expect(result.slots).toHaveLength(2);
      expect(prisma.branchSettings.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { branchId, orgId } }),
      );
    });

    // Bug #819: слот, що ПОЧИНАЄТЬСЯ після кінця робочого дня, ділити нічим — «сьогоднішня»
    // частина закінчилась раніше, ніж почалась. Раніше батьківський слот зберігався з
    // endAt < startAt (23:30 → 20:00), а продовження отримувало 3 год 50 хв замість 20 хв.
    // guards: BR-CAL-007
    it('слот 23:30–23:50 Kyiv (після кінця робочого дня) НЕ розбивається і зберігається як є', async () => {
      const prisma = buildCreateMock('20:00');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new CalendarService(prisma as any);
      // Травень → +03:00: 23:30 Kyiv = 20:30Z, 23:50 Kyiv = 20:50Z.
      const result = await service.createSlot(orgId, {
        liftId,
        startAt: '2026-05-22T20:30:00.000Z',
        endAt: '2026-05-22T20:50:00.000Z',
      } as never);
      expect(prisma._create).toHaveBeenCalledTimes(1);
      const data = prisma._create.mock.calls[0][0].data as { startAt: Date; endAt: Date };
      expect(data.startAt.toISOString()).toBe('2026-05-22T20:30:00.000Z');
      expect(data.endAt.toISOString()).toBe('2026-05-22T20:50:00.000Z');
      expect(result.slots).toHaveLength(1);
    });

    // guards: BR-CAL-007
    it('слот, що починається рівно о кінці робочого дня (20:00–21:00 Kyiv), теж не розбивається', async () => {
      const prisma = buildCreateMock('20:00');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new CalendarService(prisma as any);
      await service.createSlot(orgId, {
        liftId,
        startAt: '2026-05-22T17:00:00.000Z',
        endAt: '2026-05-22T18:00:00.000Z',
      } as never);
      expect(prisma._create).toHaveBeenCalledTimes(1);
      const data = prisma._create.mock.calls[0][0].data as { startAt: Date; endAt: Date };
      expect(data.endAt.getTime()).toBeGreaterThan(data.startAt.getTime());
    });

    it('workEndTime="20:00" (дефолт) → той самий слот НЕ розбивається', async () => {
      const prisma = buildCreateMock('20:00');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new CalendarService(prisma as any);
      const result = await service.createSlot(orgId, {
        liftId,
        startAt: '2026-05-22T13:00:00.000Z',
        endAt: '2026-05-22T16:00:00.000Z',
      } as never);
      expect(prisma._create).toHaveBeenCalledTimes(1);
      expect(result.slots).toHaveLength(1);
    });

    // resolveWorkHours fallback: невалідний "HH:mm" / workEnd≤workStart / нема BranchSettings /
    // слот без підйомника → безпечний дефолт 8..20. Слот 16:00–19:00 Kyiv (19:00 < 20:00) НЕ
    // розбивається за дефолтом → рівно 1 create. Це відрізняє fallback (8..20) від
    // «18:00»-конфігу (який би розбив).
    it('невалідний workEndTime ("bad") → fallback 8..20 → слот 16:00–19:00 НЕ розбивається', async () => {
      const prisma = buildCreateMock('bad');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new CalendarService(prisma as any);
      const result = await service.createSlot(orgId, {
        liftId,
        startAt: '2026-05-22T13:00:00.000Z',
        endAt: '2026-05-22T16:00:00.000Z',
      } as never);
      expect(prisma._create).toHaveBeenCalledTimes(1);
      expect(result.slots).toHaveLength(1);
    });

    it('workEndTime ≤ workStartTime (некоректна конфігурація) → fallback 8..20', async () => {
      // workStart 09:00, workEnd 08:00 → endHour(8) ≤ startHour(9) → fallback 8..20.
      const create = vi.fn().mockImplementation(async ({ data }: { data: { endAt: Date } }) => ({
        id: 'slot-x',
        orgId,
        liftId,
        employeeId: null,
        workOrderId: null,
        counterpartyId: null,
        vehicleId: null,
        notes: null,
        status: 'BOOKED',
        type: 'WORK',
        parentSlotId: null,
        counterparty: null,
        vehicle: null,
        workOrder: null,
        startAt: new Date(),
        endAt: data.endAt,
      }));
      const prisma = {
        lift: { findFirst: vi.fn().mockResolvedValue({ id: liftId, zone: { branchId } }) },
        employee: { findFirst: vi.fn() },
        workOrder: { findFirst: vi.fn() },
        counterparty: { findFirst: vi.fn() },
        vehicle: { findFirst: vi.fn() },
        branchSettings: {
          findFirst: vi.fn().mockResolvedValue({ workStartTime: '09:00', workEndTime: '08:00' }),
        },
        $transaction: vi
          .fn()
          .mockImplementation(async (cb: (tx: unknown) => unknown) =>
            cb({ calendarSlot: { findFirst: vi.fn().mockResolvedValue(null), create } }),
          ),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new CalendarService(prisma as any);
      const result = await service.createSlot(orgId, {
        liftId,
        startAt: '2026-05-22T13:00:00.000Z', // 16:00 Kyiv
        endAt: '2026-05-22T16:00:00.000Z', // 19:00 Kyiv < 20:00 fallback → без split
      } as never);
      expect(create).toHaveBeenCalledTimes(1);
      expect(result.slots).toHaveLength(1);
    });

    it('слот без підйомника (branchId=null) → fallback 8..20, branchSettings не читається', async () => {
      const create = vi.fn().mockImplementation(async ({ data }: { data: { endAt: Date } }) => ({
        id: 'slot-x',
        orgId,
        liftId: null,
        employeeId: null,
        workOrderId: null,
        counterpartyId: null,
        vehicleId: null,
        notes: null,
        status: 'BOOKED',
        type: 'WORK',
        parentSlotId: null,
        counterparty: null,
        vehicle: null,
        workOrder: null,
        startAt: new Date(),
        endAt: data.endAt,
      }));
      const branchSettingsFindFirst = vi.fn();
      const prisma = {
        lift: { findFirst: vi.fn() },
        employee: { findFirst: vi.fn() },
        workOrder: { findFirst: vi.fn() },
        counterparty: { findFirst: vi.fn() },
        vehicle: { findFirst: vi.fn() },
        branchSettings: { findFirst: branchSettingsFindFirst },
        $transaction: vi
          .fn()
          .mockImplementation(async (cb: (tx: unknown) => unknown) =>
            cb({ calendarSlot: { findFirst: vi.fn().mockResolvedValue(null), create } }),
          ),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new CalendarService(prisma as any);
      // Слот без liftId → resolveWorkHours(orgId, null) → fallback без DB read.
      const result = await service.createSlot(orgId, {
        startAt: '2026-05-22T13:00:00.000Z', // 16:00 Kyiv
        endAt: '2026-05-22T16:00:00.000Z', // 19:00 Kyiv < 20:00 → без split
      } as never);
      expect(create).toHaveBeenCalledTimes(1);
      expect(result.slots).toHaveLength(1);
      // Немає branchId → resolveWorkHours коротить на fallback ДО будь-якого branchSettings read.
      expect(branchSettingsFindFirst).not.toHaveBeenCalled();
    });
  });
});

// guards: BR-CAL-011
// Механік запису на блоці виду «День»: `employeeName` у відповіді `GET /calendar/slots` — і для
// ролі MECHANIC (ім'я механіка не PII клієнта). Зв'язку слот → працівник у схемі немає, тож імена
// читаються ОДНИМ запитом на всю відповідь, а не на кожен запис.
describe('findSlots — механік запису (BR-CAL-011)', () => {
  const E1 = 'e1111111-1111-4111-8111-111111111111';
  const E2 = 'e2222222-2222-4222-8222-222222222222';
  const GONE = 'e3333333-3333-4333-8333-333333333333';

  function slotRow(id: string, employeeId: string | null) {
    return {
      id,
      liftId: null,
      employeeId,
      workOrderId: null,
      vehicleId: null,
      counterpartyId: null,
      parentSlotId: null,
      startAt: new Date('2026-06-15T07:00:00.000Z'),
      endAt: new Date('2026-06-15T08:00:00.000Z'),
      notes: null,
      status: 'BOOKED',
      type: 'WORK',
      vehicle: null,
      counterparty: null,
      workOrder: {
        number: 'WO-1',
        status: 'APPROVED',
        counterpartyId: 'cp',
        counterparty: null,
        vehicle: null,
      },
    };
  }

  function setup(rows: ReturnType<typeof slotRow>[]) {
    const employeeFindMany = vi.fn().mockResolvedValue([
      { id: E1, firstName: 'Петро', lastName: 'Коваль' },
      { id: E2, firstName: 'Олена', lastName: 'Шевчук' },
    ]);
    const prisma = {
      calendarSlot: { findMany: vi.fn().mockResolvedValue(rows) },
      employee: { findMany: employeeFindMany },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { service: new CalendarService(prisma as any), employeeFindMany };
  }

  const rows = () => [
    slotRow('s1', E1),
    slotRow('s2', E2),
    slotRow('s3', E1),
    slotRow('s4', null),
    slotRow('s5', GONE),
  ];

  it.each(['ADMIN', 'MECHANIC'])(
    "%s: «Прізвище Ім'я» механіка; без механіка чи не знайдений в організації — null",
    async role => {
      const { service } = setup(rows());
      const result = await service.findSlots('org-1', '2026-06-15', role);
      expect(result.map(s => s.employeeName)).toEqual([
        'Коваль Петро',
        'Шевчук Олена',
        'Коваль Петро',
        null,
        null,
      ]);
    },
  );

  it('імена — одним запитом на всю відповідь, лише своєї організації, без повторів id', async () => {
    const { service, employeeFindMany } = setup(rows());
    await service.findSlots('org-1', '2026-06-15', 'ADMIN');
    expect(employeeFindMany).toHaveBeenCalledTimes(1);
    const { where } = employeeFindMany.mock.calls[0][0];
    expect(where.orgId).toBe('org-1');
    expect([...where.id.in].sort()).toEqual([E1, E2, GONE].sort());
  });

  it("механік не отримує клієнта, хоча ім'я механіка отримує", async () => {
    const { service } = setup([slotRow('s1', E1)]);
    const [slot] = await service.findSlots('org-1', '2026-06-15', 'MECHANIC');
    expect(slot.employeeName).toBe('Коваль Петро');
    expect(slot.counterpartyName).toBeUndefined();
    expect(slot.cpPhone).toBeNull();
  });

  it('жоден запис без механіка — працівників не читає, employeeName = null', async () => {
    const { service, employeeFindMany } = setup([slotRow('s1', null)]);
    const [slot] = await service.findSlots('org-1', '2026-06-15', 'ADMIN');
    expect(employeeFindMany).not.toHaveBeenCalled();
    expect(slot.employeeName).toBeNull();
  });

  // guards: BR-CAL-011
  it('звільнений (FIRED) чи видалений механік і працівник іншої організації — null', async () => {
    // Таблиця працівників, що ВИКОНУЄ where (`matchesWhere` фікстури): мок із фіксованою
    // відповіддю не відрізнив би запит із `deletedAt: null` і `status: { not: FIRED }` від
    // запиту без них.
    const FOREIGN = 'e4444444-4444-4444-8444-444444444444';
    const FIRED = 'e5555555-5555-4555-8555-555555555555';
    const ON_LEAVE = 'e6666666-6666-4666-8666-666666666666';
    const person = (id: string, orgId: string, lastName: string, over: object = {}) => ({
      id,
      orgId,
      firstName: 'Іван',
      lastName,
      status: 'ACTIVE',
      deletedAt: null,
      ...over,
    });
    const table = [
      person(E1, 'org-1', 'Коваль'),
      person(GONE, 'org-1', 'Видалений', { deletedAt: new Date('2026-06-01T00:00:00Z') }),
      person(FIRED, 'org-1', 'Звільнений', { status: 'FIRED' }),
      person(ON_LEAVE, 'org-1', 'Відпустка', { status: 'ON_LEAVE' }),
      person(FOREIGN, 'org-2', 'Чужий'),
    ];
    const employeeFindMany = vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      table
        .filter(e => matchesWhere(e, where))
        .map(e => ({ id: e.id, firstName: e.firstName, lastName: e.lastName })),
    );
    const prisma = {
      calendarSlot: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            slotRow('s1', E1),
            slotRow('s2', GONE),
            slotRow('s3', FIRED),
            slotRow('s4', ON_LEAVE),
            slotRow('s5', FOREIGN),
          ]),
      },
      employee: { findMany: employeeFindMany },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new CalendarService(prisma as any);
    for (const role of ['ADMIN', 'MECHANIC']) {
      const result = await service.findSlots('org-1', '2026-06-15', role);
      expect(result.map(s => s.employeeName)).toEqual([
        'Коваль Іван',
        null,
        null,
        'Відпустка Іван',
        null,
      ]);
    }
  });
});

// guards: BR-CAL-011
// Завантаження поста не рахує записи видалених нарядів — відповідь позначає такий запис.
describe('findSlots — запис видаленого наряду (BR-CAL-011)', () => {
  function row(id: string, workOrder: { deletedAt: Date | null } | null) {
    return {
      id,
      liftId: 'lift-1',
      employeeId: null,
      workOrderId: workOrder ? `wo-${id}` : null,
      vehicleId: null,
      counterpartyId: null,
      parentSlotId: null,
      startAt: new Date('2026-06-15T07:00:00.000Z'),
      endAt: new Date('2026-06-15T08:00:00.000Z'),
      notes: null,
      status: 'BOOKED',
      type: 'WORK',
      vehicle: null,
      counterparty: null,
      workOrder: workOrder && {
        number: `WO-${id}`,
        status: 'APPROVED',
        counterpartyId: 'cp',
        counterparty: null,
        vehicle: null,
        ...workOrder,
      },
    };
  }

  it.each(['ADMIN', 'MECHANIC'])(
    '%s: workOrderDeleted — true лише для видаленого наряду; наряд читається з deletedAt',
    async role => {
      const findMany = vi
        .fn()
        .mockResolvedValue([
          row('s1', { deletedAt: new Date('2026-06-10T00:00:00Z') }),
          row('s2', { deletedAt: null }),
          row('s3', null),
        ]);
      const prisma = { calendarSlot: { findMany }, employee: { findMany: vi.fn() } };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const service = new CalendarService(prisma as any);
      const result = await service.findSlots('org-1', '2026-06-15', role);
      expect(result.map(s => s.workOrderDeleted)).toEqual([true, false, false]);
      const args = findMany.mock.calls[0][0];
      const woSelect = (args.select ?? args.include).workOrder.select;
      expect(woSelect.deletedAt).toBe(true);
    },
  );
});
