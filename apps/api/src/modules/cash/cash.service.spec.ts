import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CashService } from './cash.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const REG = '22222222-2222-4222-8222-222222222222';

function makeMocks() {
  return {
    prisma: {
      cashRegister: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        findFirstOrThrow: vi.fn(),
      },
      cashShift: { findFirst: vi.fn() },
      cashOperation: { create: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
      expenseCategory: { findFirst: vi.fn() },
      garageBranch: { findFirst: vi.fn() },
      currency: { findFirst: vi.fn() },
      $transaction: vi.fn(),
    },
    audit: { record: vi.fn().mockResolvedValue(undefined) },
  };
}
function makeService(m: ReturnType<typeof makeMocks>): CashService {
  const s = new CashService(
    m.prisma as unknown as PrismaService,
    m.audit as unknown as AuditService,
  );
  // $transaction прокидає callback з тим самим prisma-моком (client = prisma).
  m.prisma.$transaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) =>
    fn(m.prisma),
  );
  return s;
}

describe('CashService.createOperation — єдина точка руху', () => {
  let m: ReturnType<typeof makeMocks>;
  let service: CashService;
  beforeEach(() => {
    m = makeMocks();
    service = makeService(m);
    m.prisma.cashOperation.create.mockResolvedValue({
      id: 'op-1',
      cashRegisterId: REG,
      cashShiftId: null,
      direction: 'IN',
      amount: 500,
      reason: 'MANUAL_IN',
      expenseCategoryId: null,
      counterpartyId: null,
      employeeId: null,
      documentType: null,
      documentId: null,
      notes: null,
      createdAt: new Date(),
      expenseCategory: null,
    });
  });

  it('нефіскальна каса → операція без зміни (cashShiftId=null)', async () => {
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce({
      id: REG,
      isFiscal: false,
      branchId: 'b1',
    });
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'IN',
      amount: 500,
      reason: 'MANUAL_IN',
    });
    expect(m.prisma.cashShift.findFirst).not.toHaveBeenCalled();
    expect(m.prisma.cashOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cashShiftId: null, direction: 'IN', amount: 500 }),
      }),
    );
  });

  it('фіскальна каса без відкритої зміни → BadRequest', async () => {
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce({
      id: REG,
      isFiscal: true,
      branchId: 'b1',
    });
    m.prisma.cashShift.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.createOperation(ORG, {
        cashRegisterId: REG,
        direction: 'IN',
        amount: 100,
        reason: 'MANUAL_IN',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(m.prisma.cashOperation.create).not.toHaveBeenCalled();
  });

  it('фіскальна каса з відкритою зміною → cashShiftId проставлено', async () => {
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce({
      id: REG,
      isFiscal: true,
      branchId: 'b1',
    });
    m.prisma.cashShift.findFirst.mockResolvedValueOnce({ id: 'shift-1' });
    await service.createOperation(ORG, {
      cashRegisterId: REG,
      direction: 'OUT',
      amount: 100,
      reason: 'PAYROLL',
    });
    expect(m.prisma.cashOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cashShiftId: 'shift-1' }) }),
    );
  });

  it('каса не належить org → 404', async () => {
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.createOperation(ORG, {
        cashRegisterId: REG,
        direction: 'IN',
        amount: 100,
        reason: 'MANUAL_IN',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('amount ≤ 0 → BadRequest', async () => {
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce({
      id: REG,
      isFiscal: false,
      branchId: 'b1',
    });
    await expect(
      service.createOperation(ORG, {
        cashRegisterId: REG,
        direction: 'IN',
        amount: 0,
        reason: 'MANUAL_IN',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('expenseCategoryId не належить org → 404', async () => {
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce({
      id: REG,
      isFiscal: false,
      branchId: 'b1',
    });
    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.createOperation(ORG, {
        cashRegisterId: REG,
        direction: 'OUT',
        amount: 100,
        reason: 'EXPENSE',
        expenseCategoryId: 'cat-x',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('зовнішній tx → без власного $transaction', async () => {
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce({
      id: REG,
      isFiscal: false,
      branchId: 'b1',
    });
    const tx = {
      cashRegister: m.prisma.cashRegister,
      cashShift: m.prisma.cashShift,
      expenseCategory: m.prisma.expenseCategory,
      cashOperation: m.prisma.cashOperation,
    };
    await service.createOperation(
      ORG,
      { cashRegisterId: REG, direction: 'IN', amount: 500, reason: 'SALE_PAYMENT' },
      tx as never,
    );
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
    expect(m.prisma.cashOperation.create).toHaveBeenCalled();
  });
});

describe('CashService.createManual — EXPENSE вимагає статтю', () => {
  it('EXPENSE без expenseCategoryId → BadRequest', async () => {
    const m = makeMocks();
    const service = makeService(m);
    await expect(
      service.createManual(ORG, REG, { direction: 'OUT', amount: 100, reason: 'EXPENSE' } as never),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('CashService.getBalance — initial + Σ(sign)', () => {
  it('balance = initialBalance + IN − OUT', async () => {
    const m = makeMocks();
    const service = makeService(m);
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce({ initialBalance: 1000 });
    m.prisma.cashOperation.aggregate
      .mockResolvedValueOnce({ _sum: { amount: 3000 } }) // IN
      .mockResolvedValueOnce({ _sum: { amount: 1200 } }); // OUT
    const balance = await service.getBalance(ORG, REG);
    expect(balance).toBe(2800); // 1000 + 3000 − 1200
  });

  it('каса не знайдена → 404', async () => {
    const m = makeMocks();
    const service = makeService(m);
    m.prisma.cashRegister.findFirst.mockResolvedValueOnce(null);
    await expect(service.getBalance(ORG, REG)).rejects.toThrow(NotFoundException);
  });
});
