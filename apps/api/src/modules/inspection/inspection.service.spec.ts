import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { InspectionService } from './inspection.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Bug #254: unit-покриття `InspectionService.create`.
 *
 * Фокус:
 *   • Tenant guard — WO має належати org.
 *   • Idempotency — повторний звіт для того ж WO → ConflictException.
 *   • EDITABLE_STATUSES — НЕ можна додавати lines у not-editable WO коли є CRITICAL points.
 *   • Auto-create lines — labour amount = normoHours * price (skill §5.1).
 *
 * Без spec regression у EDITABLE_STATUSES guard (видалення/інверсія) мовчки
 * створюватиме lines у COMPLETED/PAID нарядах (totalAmount inflation + invalid FSM state).
 */
describe('InspectionService.create', () => {
  let service: InspectionService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  const orgId = 'org-1';
  const workOrderId = 'wo-1';
  const userId = 'user-1';

  beforeEach(async () => {
    prisma = {
      workOrder: {
        findFirst: vi.fn(),
        update: vi.fn(),
      },
      inspectionReport: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        create: vi.fn(),
      },
      work: { findMany: vi.fn() },
      workOrderLine: { create: vi.fn() },
      $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<unknown>) => await cb(prisma)),
    };
    const module = await Test.createTestingModule({
      providers: [InspectionService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(InspectionService);
  });

  const dtoNoCritical = {
    mileage: 100000,
    points: [
      { name: 'Гальмівні колодки', value: '8', unit: 'мм', status: 'OK' as const },
      { name: 'Шини', value: '70', unit: '%', status: 'WARN' as const },
    ],
  };
  const dtoWithCritical = {
    points: [{ name: 'Гальмівні колодки', value: '1', unit: 'мм', status: 'CRITICAL' as const }],
  };

  it('happy path без CRITICAL: створює report, lines НЕ створюються', async () => {
    prisma.workOrder.findFirst.mockResolvedValueOnce({
      id: workOrderId,
      orgId,
      status: 'DRAFT',
    });
    prisma.inspectionReport.findUnique.mockResolvedValueOnce(null);
    prisma.inspectionReport.create.mockResolvedValueOnce({
      id: 'rep-1',
      orgId,
      workOrderId,
      mileage: 100000,
      points: dtoNoCritical.points,
      createdBy: userId,
      createdAt: new Date(),
    });

    const result = await service.create(orgId, workOrderId, dtoNoCritical, userId);

    expect(prisma.inspectionReport.create).toHaveBeenCalledTimes(1);
    expect(prisma.workOrderLine.create).not.toHaveBeenCalled();
    expect(prisma.workOrder.update).not.toHaveBeenCalled();
    expect(result.autoCreatedLines).toBe(0);
  });

  it('повторний звіт для того ж WO → ConflictException; inspectionReport.create НЕ викликаний', async () => {
    prisma.workOrder.findFirst.mockResolvedValueOnce({
      id: workOrderId,
      orgId,
      status: 'DRAFT',
    });
    prisma.inspectionReport.findUnique.mockResolvedValueOnce({ id: 'existing-rep' });

    await expect(service.create(orgId, workOrderId, dtoNoCritical, userId)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.inspectionReport.create).not.toHaveBeenCalled();
  });

  it('cross-tenant WO → NotFoundException', async () => {
    prisma.workOrder.findFirst.mockResolvedValueOnce(null);
    prisma.inspectionReport.findUnique.mockResolvedValueOnce(null);

    await expect(service.create(orgId, workOrderId, dtoNoCritical, userId)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('CRITICAL points + non-editable WO (COMPLETED) → BadRequestException', async () => {
    prisma.workOrder.findFirst.mockResolvedValueOnce({
      id: workOrderId,
      orgId,
      status: 'COMPLETED',
    });
    prisma.inspectionReport.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.create(orgId, workOrderId, dtoWithCritical, userId),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Critical regression guard — захист від інверсії EDITABLE_STATUSES.
    expect(prisma.inspectionReport.create).not.toHaveBeenCalled();
    expect(prisma.workOrderLine.create).not.toHaveBeenCalled();
  });

  it('CRITICAL points + editable WO: створює line з amount = normoHours * price', async () => {
    prisma.workOrder.findFirst.mockResolvedValueOnce({
      id: workOrderId,
      orgId,
      status: 'DRAFT',
    });
    prisma.inspectionReport.findUnique.mockResolvedValueOnce(null);
    prisma.work.findMany.mockResolvedValueOnce([
      {
        id: 'work-1',
        // Має містити exact pointName (case-insensitive) — service шукає
        // `w.name.toLowerCase().includes(p.name.toLowerCase())`. Шукаємо "Гальмівні колодки".
        name: 'Гальмівні колодки — заміна',
        price: 100,
        normoHours: 1.5,
      },
    ]);
    prisma.inspectionReport.create.mockResolvedValueOnce({
      id: 'rep-1',
      orgId,
      workOrderId,
      mileage: null,
      points: dtoWithCritical.points,
      createdBy: userId,
      createdAt: new Date(),
    });
    prisma.workOrderLine.create.mockResolvedValueOnce({ id: 'line-1' });
    prisma.workOrder.update.mockResolvedValueOnce({});

    const result = await service.create(orgId, workOrderId, dtoWithCritical, userId);

    expect(prisma.workOrderLine.create).toHaveBeenCalledTimes(1);
    const lineArgs = prisma.workOrderLine.create.mock.calls[0][0];
    // Bug pattern §5.1: amount = normoHours * price = 1.5 * 100 = 150
    expect(lineArgs.data.amount).toBe(150);
    expect(lineArgs.data.workId).toBe('work-1');

    // WO totals incremented by labour
    expect(prisma.workOrder.update).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.workOrder.update.mock.calls[0][0];
    expect(updateArgs.data.totalLabor).toEqual({ increment: 150 });
    expect(updateArgs.data.totalAmount).toEqual({ increment: 150 });

    expect(result.autoCreatedLines).toBe(1);
  });
});
