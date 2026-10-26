import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { PayrollService } from './payroll.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { CashService } from '../cash/cash.service';

// Аспект: видалення періоду зарплати — PayrollService.remove (BR-PAYR-012; рішення власника №9:
// період із рознесеними на нього рядками виписки не видаляється). Винесено з payroll.service.spec.ts
// (гейт B, 2026-10-26).

const ORG = '11111111-1111-4111-8111-111111111111';
const PID = '22222222-2222-4222-8222-222222222222';

function makeMocks() {
  return {
    prisma: {
      payrollPeriod: {
        findFirst: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      // Рядки виписки, рознесені на період: за замовчуванням немає.
      bankTransaction: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    audit: { record: vi.fn().mockResolvedValue(undefined) },
  };
}

function makeService(m: ReturnType<typeof makeMocks>): PayrollService {
  return new PayrollService(
    m.prisma as unknown as PrismaService,
    m.audit as unknown as AuditService,
    {} as unknown as CashService,
  );
}

describe('PayrollService.remove — guard', () => {
  let m: ReturnType<typeof makeMocks>;
  let service: PayrollService;
  beforeEach(() => {
    m = makeMocks();
    service = makeService(m);
  });

  // guards: BR-PAYR-012
  it('PAID не видаляється → BadRequest', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({ status: 'PAID' });
    await expect(service.remove(ORG, PID)).rejects.toThrow(BadRequestException);
    expect(m.prisma.payrollPeriod.updateMany).not.toHaveBeenCalled();
  });

  // guards: BR-PAYR-012
  it('COMPUTED видаляється (ще не виплачено) → soft-delete', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({ status: 'COMPUTED' });
    await service.remove(ORG, PID, 'user-1');
    expect(m.prisma.payrollPeriod.updateMany).toHaveBeenCalledWith({
      where: {
        id: PID,
        orgId: ORG,
        deletedAt: null,
        status: { not: 'PAID' },
        bankTransactions: { none: { status: 'MATCHED', deletedAt: null } },
      },
      data: { deletedAt: expect.any(Date) },
    });
  });

  // Рішення власника №9 (2026-10-26). Мутація: прибрати перевірку `reconciledLine` у remove →
  // перший кейс червоніє (період видалено); прибрати `status: 'MATCHED'` / `deletedAt: null` /
  // `orgId` / `payrollPeriodId` з пошуку → другий кейс червоніє.
  // guards: BR-PAYR-012
  it('на період рознесено рядок виписки → 400 hasReconciledLines, період не видалено', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({ status: 'COMPUTED' });
    m.prisma.bankTransaction.findFirst.mockResolvedValueOnce({ id: 'bt-1' });
    await expect(service.remove(ORG, PID, 'user-1')).rejects.toThrow(
      translateError('err.payroll.hasReconciledLines', 'uk'),
    );
    expect(m.prisma.payrollPeriod.updateMany).not.toHaveBeenCalled();
    expect(m.audit.record).not.toHaveBeenCalled();
  });

  // guards: BR-PAYR-012
  it('рознесені рядки шукаються лише живі MATCHED цього періоду своєї організації', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({ status: 'DRAFT' });
    await service.remove(ORG, PID, 'user-1');
    expect(m.prisma.bankTransaction.findFirst).toHaveBeenCalledWith({
      where: { orgId: ORG, payrollPeriodId: PID, status: 'MATCHED', deletedAt: null },
      select: { id: true },
    });
    expect(m.prisma.payrollPeriod.updateMany).toHaveBeenCalled();
  });

  // guards: BR-PAYR-012
  // Мутація: прибрати `bankTransactions: { none }` з запису чи повторну перевірку після count = 0
  // → рознесення, що пройшло між перевіркою і видаленням, дає 400 paidNotDeletable / видалення.
  it('рядок рознесли між перевіркою і видаленням (запис не пройшов) → 400 hasReconciledLines', async () => {
    m.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce({ status: 'COMPUTED' })
      .mockResolvedValueOnce({ status: 'COMPUTED' });
    m.prisma.bankTransaction.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'bt-1' });
    m.prisma.payrollPeriod.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.remove(ORG, PID, 'user-1')).rejects.toThrow(
      translateError('err.payroll.hasReconciledLines', 'uk'),
    );
    expect(m.audit.record).not.toHaveBeenCalled();
  });

  // guards: BR-PAYR-012
  it('DRAFT → soft-delete', async () => {
    m.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({ status: 'DRAFT' });
    await service.remove(ORG, PID, 'user-1');
    expect(m.prisma.payrollPeriod.updateMany).toHaveBeenCalledWith({
      where: {
        id: PID,
        orgId: ORG,
        deletedAt: null,
        status: { not: 'PAID' },
        bankTransactions: { none: { status: 'MATCHED', deletedAt: null } },
      },
      data: { deletedAt: expect.any(Date) },
    });
  });
});
