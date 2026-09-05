import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { CalendarService } from './calendar.service';

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
});
