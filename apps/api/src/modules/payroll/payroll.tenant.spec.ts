/**
 * Ізоляція організацій у зарплаті (BR-PAYR-013): кожне читання і кожен запис несе orgId
 * викликача; чужа або видалена відомість — це «не знайдено».
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import {
  BRANCH,
  ORG,
  PID,
  aggRow,
  makePayrollFixture,
  periodRow,
  sqlText,
  sqlValues,
} from './payroll.spec-fixture';

type Fixture = ReturnType<typeof makePayrollFixture>;

const BY_ID: [string, (f: Fixture) => Promise<unknown>][] = [
  ['findOne', f => f.service.findOne(ORG, PID)],
  ['compute', f => f.service.compute(ORG, PID, 'user-1')],
  ['pay', f => f.service.pay(ORG, PID, 'user-1', 'reg-1')],
  ['remove', f => f.service.remove(ORG, PID, 'user-1')],
];

describe('PayrollService — ізоляція організацій', () => {
  let f: Fixture;
  beforeEach(() => {
    f = makePayrollFixture();
  });

  // guards: BR-PAYR-013
  it.each(BY_ID)(
    '%s шукає відомість за id + orgId викликача + «не видалена»',
    async (_name, call) => {
      f.prisma.payrollPeriod.findFirst.mockResolvedValue(null);
      await expect(call(f)).rejects.toThrow(NotFoundException);
      expect(f.prisma.payrollPeriod.findFirst.mock.calls[0]![0].where).toEqual({
        id: PID,
        orgId: ORG,
        deletedAt: null,
      });
    },
  );

  // guards: BR-PAYR-013
  it.each(BY_ID)(
    '%s по чужій відомості → «Період не знайдено», жодного запису й касової операції',
    async (_name, call) => {
      f.prisma.payrollPeriod.findFirst.mockResolvedValue(null);
      await expect(call(f)).rejects.toThrow('Період не знайдено');
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
      expect(f.prisma.payrollPeriod.updateMany).not.toHaveBeenCalled();
      expect(f.cash.createOperation).not.toHaveBeenCalled();
    },
  );

  // guards: BR-PAYR-013
  it('філія перевіряється в межах організації викликача (попередній розрахунок і створення)', async () => {
    f.prisma.payrollPeriod.create.mockResolvedValue(periodRow({ branchId: BRANCH }));
    const expectedWhere = { id: BRANCH, orgId: ORG, deletedAt: null };

    await f.service.preview(ORG, '2026-09-01', '2026-09-30', BRANCH);
    expect(f.prisma.garageBranch.findFirst.mock.calls[0]![0].where).toEqual(expectedWhere);

    await f.service.create(ORG, {
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      branchId: BRANCH,
    });
    expect(f.prisma.garageBranch.findFirst.mock.calls[1]![0].where).toEqual(expectedWhere);
  });

  // guards: BR-PAYR-013
  it('агрегат виробітку отримує orgId і для рядків робіт, і для нарядів — в обох запитах', async () => {
    f.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce(periodRow({ status: 'DRAFT' }))
      .mockResolvedValueOnce(periodRow({ status: 'COMPUTED' }));

    await f.service.compute(ORG, PID, 'user-1');

    for (const call of [0, 1]) {
      expect(sqlValues(f.prisma.$queryRaw, call).slice(0, 2)).toEqual([ORG, ORG]);
      const text = sqlText(f.prisma.$queryRaw, call);
      expect(text).toContain('wol."orgId" = ?::uuid');
      expect(text).toContain('wo."orgId" = ?::uuid');
    }
  });

  // guards: BR-PAYR-013
  it('розрахунок пише й чистить лише в організації викликача', async () => {
    f.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce(periodRow({ status: 'DRAFT' }))
      .mockResolvedValueOnce(periodRow({ status: 'COMPUTED' }));
    f.tx.payrollLine.findMany.mockResolvedValueOnce([{ id: 'old-line-1' }]);
    f.prisma.$queryRaw.mockResolvedValueOnce([aggRow()]).mockResolvedValueOnce([
      {
        employeeId: 'e1',
        workOrderId: 'wo-1',
        workOrderNumber: 'НРД-2026-0001',
        make: 'Toyota',
        model: 'Camry',
        licensePlate: 'AA1234BB',
        worksCount: 3n,
        normoHours: 10,
        baseAmount: 5000,
      },
    ]);

    await f.service.compute(ORG, PID, 'user-1');

    expect(f.tx.payrollPeriod.updateMany.mock.calls[0]![0].where.orgId).toBe(ORG);
    expect(f.tx.payrollLine.findMany.mock.calls[0]![0].where).toEqual({
      orgId: ORG,
      periodId: PID,
    });
    expect(f.tx.payrollLineWorkOrder.deleteMany.mock.calls[0]![0].where.orgId).toBe(ORG);
    expect(f.tx.payrollLine.deleteMany).toHaveBeenCalledWith({
      where: { orgId: ORG, periodId: PID },
    });
    expect(f.tx.payrollLine.create.mock.calls[0]![0].data.orgId).toBe(ORG);
    expect(f.tx.payrollLineWorkOrder.createMany.mock.calls[0]![0].data[0].orgId).toBe(ORG);
  });

  // guards: BR-PAYR-013
  it('виплата читає рядки своєї організації й передає її orgId касі', async () => {
    f.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce(periodRow({ status: 'COMPUTED' }))
      .mockResolvedValueOnce(periodRow({ status: 'PAID' }));
    f.prisma.payrollLine.findMany.mockResolvedValueOnce([{ employeeId: 'e1', accruedAmount: 300 }]);

    await f.service.pay(ORG, PID, 'user-1', 'reg-1');

    expect(f.prisma.payrollLine.findMany.mock.calls[0]![0].where).toEqual({
      orgId: ORG,
      periodId: PID,
    });
    expect(f.tx.payrollPeriod.updateMany.mock.calls[0]![0].where.orgId).toBe(ORG);
    expect(f.cash.createOperation.mock.calls[0]![0]).toBe(ORG);
  });

  // guards: BR-PAYR-013
  it('нова відомість записується в організацію викликача', async () => {
    f.prisma.payrollPeriod.create.mockResolvedValue(periodRow());
    await f.service.create(ORG, { periodStart: '2026-09-01', periodEnd: '2026-09-30' });
    expect(f.prisma.payrollPeriod.create.mock.calls[0]![0].data.orgId).toBe(ORG);
  });
});
