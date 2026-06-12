import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
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
    // First call inside $transaction — soft-delete continuation
    updateMany.mockResolvedValueOnce({ count: 0 });
    // Second call — update parent
    updateMany.mockResolvedValueOnce({ count: opts.updatedCount ?? 1 });

    // findFirst within $transaction is called twice for the conflict check path
    // (parentSlot lookup, then conflict probe). Default: no parent → conflict check skipped.
    const findFirst = vi.fn();
    findFirst.mockResolvedValueOnce(opts.parentSlot ?? null); // parent slot lookup
    if (opts.parentSlot) {
      findFirst.mockResolvedValueOnce(opts.conflictingSlot ?? null); // conflict probe
    }

    const txCalendarSlot = { updateMany, findFirst };

    return {
      workOrder: {
        findFirst: vi
          .fn()
          .mockResolvedValue(opts.workOrderExists === false ? null : { id: workOrderId }),
      },
      $transaction: vi.fn().mockImplementation(async cb => cb({ calendarSlot: txCalendarSlot })),
      _txCalendarSlot: txCalendarSlot,
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
    // Жодного запиту до DB не повинно бути — перевірка до tenant lookup.
    expect(prisma.workOrder.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
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
    expect(prisma.workOrder.findFirst).toHaveBeenCalledWith({
      where: { id: workOrderId, orgId, deletedAt: null },
      select: { id: true },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
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
