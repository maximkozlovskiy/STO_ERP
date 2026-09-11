import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PayrollService } from './payroll.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const PID = '22222222-2222-4222-8222-222222222222';

function makeMocks() {
  const tx = {
    payrollPeriod: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    payrollLine: { deleteMany: vi.fn(), createMany: vi.fn() },
    $executeRaw: vi.fn(),
  };
  return {
    tx,
    prisma: {
      payrollPeriod: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      payrollLine: { findMany: vi.fn().mockResolvedValue([]) },
      garageBranch: { findFirst: vi.fn() },
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi
        .fn()
        .mockImplementation(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    },
    audit: { record: vi.fn().mockResolvedValue(undefined) },
    cash: { createOperation: vi.fn().mockResolvedValue(undefined) },
  };
}

function makeService(m: ReturnType<typeof makeMocks>): PayrollService {
  return new PayrollService(
    m.prisma as unknown as PrismaService,
    m.audit as unknown as AuditService,
    m.cash as unknown as import('../cash/cash.service').CashService,
  );
}

describe('PayrollService.preview', () => {
  let m: ReturnType<typeof makeMocks>;
  let service: PayrollService;
  beforeEach(() => {
    m = makeMocks();
    service = makeService(m);
  });

  it('агрегує виробіток і рахує accrued за rateScheme', async () => {
    m.prisma.$queryRaw.mockResolvedValueOnce([
      {
        employeeId: 'e1',
        firstName: 'Іван',
        lastName: 'Коваль',
        rateScheme: { type: 'percent_normo', params: { percent: 40 } },
        totalNormoHours: 10,
        totalAmount: 5000,
        linesCount: 3n,
      },
    ]);
    const res = await service.preview(ORG, '2026-09-01', '2026-09-30');
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0].accruedAmount).toBe(2000); // 40% від 5000
    expect(res.totalAccrued).toBe(2000);
  });

  it('невалідна rateScheme → accrued 0, rateSchemeType=unknown', async () => {
    m.prisma.$queryRaw.mockResolvedValueOnce([
      {
        employeeId: 'e1',
        firstName: 'A',
        lastName: 'B',
        rateScheme: { garbage: true },
        totalNormoHours: 10,
        totalAmount: 5000,
        linesCount: 1n,
      },
    ]);
    const res = await service.preview(ORG, '2026-09-01', '2026-09-30');
    expect(res.lines[0].accruedAmount).toBe(0);
    expect(res.lines[0].rateSchemeType).toBe('unknown');
  });

  it('from > to → BadRequest', async () => {
    await expect(service.preview(ORG, '2026-09-30', '2026-09-01')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('branchId не належить org → 404', async () => {
    m.prisma.garageBranch.findFirst.mockResolvedValueOnce(null);
    await expect(service.preview(ORG, '2026-09-01', '2026-09-30', 'bad-branch')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('PayrollService.compute — FSM', () => {
  let m: ReturnType<typeof makeMocks>;
  let service: PayrollService;
  beforeEach(() => {
    m = makeMocks();
    service = makeService(m);
  });

  it('не-DRAFT → BadRequest (не рахуємо)', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({
      id: PID,
      status: 'COMPUTED',
      periodStart: new Date('2026-09-01'),
      periodEnd: new Date('2026-09-30'),
      branchId: null,
    });
    await expect(service.compute(ORG, PID)).rejects.toThrow(BadRequestException);
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('період не знайдено → 404', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce(null);
    await expect(service.compute(ORG, PID)).rejects.toThrow(NotFoundException);
  });

  it('DRAFT → фіксує lines у транзакції (claim + createMany)', async () => {
    m.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce({
        id: PID,
        status: 'DRAFT',
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-30'),
        branchId: null,
      })
      .mockResolvedValueOnce({
        id: PID,
        orgId: ORG,
        branchId: null,
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-30'),
        status: 'COMPUTED',
        note: null,
        computedAt: new Date(),
        paidAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        lines: [],
      });
    m.prisma.$queryRaw.mockResolvedValueOnce([
      {
        employeeId: 'e1',
        firstName: 'A',
        lastName: 'B',
        rateScheme: { type: 'per_normo_hour', params: { ratePerHour: 100 } },
        totalNormoHours: 5,
        totalAmount: 0,
        linesCount: 1n,
      },
    ]);

    await service.compute(ORG, PID, 'user-1');

    expect(m.tx.payrollPeriod.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PID, orgId: ORG, status: 'DRAFT' } }),
    );
    expect(m.tx.payrollLine.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ employeeId: 'e1', accruedAmount: 500 })], // 100×5
      }),
    );
  });

  it('claim програв гонку (count=0) → BadRequest', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({
      id: PID,
      status: 'DRAFT',
      periodStart: new Date('2026-09-01'),
      periodEnd: new Date('2026-09-30'),
      branchId: null,
    });
    m.tx.payrollPeriod.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.compute(ORG, PID)).rejects.toThrow(BadRequestException);
  });
});

describe('PayrollService.pay — FSM', () => {
  let m: ReturnType<typeof makeMocks>;
  let service: PayrollService;
  beforeEach(() => {
    m = makeMocks();
    service = makeService(m);
  });

  it('не-COMPUTED → BadRequest', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({ id: PID, status: 'DRAFT' });
    await expect(service.pay(ORG, PID)).rejects.toThrow(BadRequestException);
  });

  it('COMPUTED → PAID (updateMany claim + paidAmount=accrued)', async () => {
    m.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce({ id: PID, status: 'COMPUTED' })
      .mockResolvedValueOnce({
        id: PID,
        orgId: ORG,
        branchId: null,
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-30'),
        status: 'PAID',
        note: null,
        computedAt: new Date(),
        paidAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        lines: [],
      });
    await service.pay(ORG, PID, 'user-1');
    expect(m.tx.payrollPeriod.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PID, orgId: ORG, status: 'COMPUTED' } }),
    );
    expect(m.tx.$executeRaw).toHaveBeenCalled();
  });
});

describe('PayrollService.remove — guard', () => {
  let m: ReturnType<typeof makeMocks>;
  let service: PayrollService;
  beforeEach(() => {
    m = makeMocks();
    service = makeService(m);
  });

  it('PAID не видаляється → BadRequest', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({ status: 'PAID' });
    await expect(service.remove(ORG, PID)).rejects.toThrow(BadRequestException);
    expect(m.prisma.payrollPeriod.updateMany).not.toHaveBeenCalled();
  });

  it('COMPUTED видаляється (ще не виплачено) → soft-delete', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({ status: 'COMPUTED' });
    await service.remove(ORG, PID, 'user-1');
    expect(m.prisma.payrollPeriod.updateMany).toHaveBeenCalledWith({
      where: { id: PID, orgId: ORG, deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it('DRAFT → soft-delete', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({ status: 'DRAFT' });
    await service.remove(ORG, PID, 'user-1');
    expect(m.prisma.payrollPeriod.updateMany).toHaveBeenCalledWith({
      where: { id: PID, orgId: ORG, deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });
});
