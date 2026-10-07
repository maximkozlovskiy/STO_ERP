/**
 * Життєвий цикл відомості: створення й розрахунок (BR-PAYR-009), виплата (BR-PAYR-010),
 * каса (BR-PAYR-011), видалення (BR-PAYR-012). Доповнює FSM-кейси `payroll.service.spec.ts`
 * тим, чого там немає: решта статусів, зміст знімка, зміст запису виплати.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import {
  ORG,
  PID,
  aggRow,
  makePayrollFixture,
  periodRow,
  sqlText,
  sqlValues,
} from './payroll.spec-fixture';

describe('PayrollService.create — відомість народжується чернеткою', () => {
  let f: ReturnType<typeof makePayrollFixture>;
  beforeEach(() => {
    f = makePayrollFixture();
    f.prisma.payrollPeriod.create.mockResolvedValue(periodRow());
  });

  // guards: BR-PAYR-009
  it('створює DRAFT без рядків: дати як задано, без філії — branchId null', async () => {
    const dto = await f.service.create(ORG, {
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      note: 'Вересень 2026',
    });

    expect(f.prisma.payrollPeriod.create).toHaveBeenCalledWith({
      data: {
        orgId: ORG,
        branchId: null,
        periodStart: new Date('2026-09-01T00:00:00Z'),
        periodEnd: new Date('2026-09-30T00:00:00Z'),
        note: 'Вересень 2026',
        status: 'DRAFT',
      },
      include: { lines: true },
    });
    // Створення нічого не рахує: агрегат виробітку не запускається.
    expect(f.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(dto.status).toBe('DRAFT');
    expect(dto.totalAccrued).toBe(0);
  });
});

describe('PayrollService.compute — DRAFT → COMPUTED і знімок', () => {
  let f: ReturnType<typeof makePayrollFixture>;
  beforeEach(() => {
    f = makePayrollFixture();
  });

  // guards: BR-PAYR-009
  it.each(['COMPUTED', 'PAID', 'CANCELLED'])(
    'статус %s не розраховується повторно → 400, нічого не читається й не пишеться',
    async status => {
      f.prisma.payrollPeriod.findFirst.mockResolvedValueOnce(periodRow({ status }));
      await expect(f.service.compute(ORG, PID, 'user-1')).rejects.toThrow(
        'Розрахувати можна лише період у статусі «Чернетка»',
      );
      expect(f.prisma.$queryRaw).not.toHaveBeenCalled();
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  // guards: BR-PAYR-009
  it('перехід фіксує статус COMPUTED, час і автора розрахунку', async () => {
    f.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce(periodRow({ status: 'DRAFT' }))
      .mockResolvedValueOnce(periodRow({ status: 'COMPUTED' }));

    await f.service.compute(ORG, PID, 'user-1');

    expect(f.tx.payrollPeriod.updateMany).toHaveBeenCalledWith({
      where: { id: PID, orgId: ORG, status: 'DRAFT' },
      data: { status: 'COMPUTED', computedAt: expect.any(Date), computedBy: 'user-1' },
    });
  });

  // guards: BR-PAYR-009
  it('знімок рядка: співробітник, тип схеми, база, нормо-години, кількість робіт і нараховане', async () => {
    f.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce(periodRow({ status: 'DRAFT' }))
      .mockResolvedValueOnce(periodRow({ status: 'COMPUTED' }));
    f.prisma.$queryRaw
      .mockResolvedValueOnce([
        aggRow({
          employeeId: 'e1',
          rateScheme: {
            type: 'fixed_plus_bonus',
            params: { fixedMonthly: 8000, bonusPercent: 10 },
          },
          totalAmount: 12345.67,
          totalNormoHours: 17.5,
          linesCount: 6n,
        }),
      ])
      .mockResolvedValueOnce([]);

    await f.service.compute(ORG, PID, 'user-1');

    expect(f.tx.payrollLine.create).toHaveBeenCalledTimes(1);
    expect(f.tx.payrollLine.create).toHaveBeenCalledWith({
      data: {
        orgId: ORG,
        periodId: PID,
        employeeId: 'e1',
        rateSchemeType: 'fixed_plus_bonus',
        baseAmount: 12345.67,
        normoHours: 17.5,
        linesCount: 6,
        accruedAmount: 9234.57, // 8000 + 10% × 12345.67 = 9234.567 → 9234.57
      },
      select: { id: true },
    });
  });

  // guards: BR-PAYR-009
  it('рядок на кожного співробітника з виробітком — по одному, у порядку агрегату', async () => {
    f.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce(periodRow({ status: 'DRAFT' }))
      .mockResolvedValueOnce(periodRow({ status: 'COMPUTED' }));
    f.prisma.$queryRaw
      .mockResolvedValueOnce([
        aggRow({ employeeId: 'e1', totalAmount: 5000 }),
        aggRow({ employeeId: 'e2', totalAmount: 1000 }),
        aggRow({ employeeId: 'e3', totalAmount: 0, rateScheme: null }),
      ])
      .mockResolvedValueOnce([]);

    await f.service.compute(ORG, PID, 'user-1');

    const written = f.tx.payrollLine.create.mock.calls.map(
      c => (c[0] as { data: { employeeId: string; accruedAmount: number } }).data,
    );
    expect(written.map(d => [d.employeeId, d.accruedAmount])).toEqual([
      ['e1', 2000],
      ['e2', 400],
      ['e3', 0], // без схеми — рядок усе одно є, нараховано 0
    ]);
  });

  // guards: BR-PAYR-009
  it('жодної завершеної роботи за період → відомість усе одно стає COMPUTED, без рядків', async () => {
    f.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce(periodRow({ status: 'DRAFT' }))
      .mockResolvedValueOnce(periodRow({ status: 'COMPUTED' }));

    const dto = await f.service.compute(ORG, PID, 'user-1');

    expect(f.tx.payrollPeriod.updateMany).toHaveBeenCalledTimes(1);
    expect(f.tx.payrollLine.create).not.toHaveBeenCalled();
    expect(f.tx.payrollLineWorkOrder.createMany).not.toHaveBeenCalled();
    expect(dto.status).toBe('COMPUTED');
  });

  // guards: BR-PAYR-009
  it('програна гонка за розрахунок → 400 з текстом, рядки не чіпаються', async () => {
    f.prisma.payrollPeriod.findFirst.mockResolvedValueOnce(periodRow({ status: 'DRAFT' }));
    f.prisma.$queryRaw.mockResolvedValueOnce([aggRow()]).mockResolvedValueOnce([]);
    f.tx.payrollPeriod.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(f.service.compute(ORG, PID, 'user-1')).rejects.toThrow(
      'Період уже розраховано або змінено іншим користувачем',
    );
    expect(f.tx.payrollLine.deleteMany).not.toHaveBeenCalled();
    expect(f.tx.payrollLine.create).not.toHaveBeenCalled();
  });
});

describe('PayrollService — підсумки відомості', () => {
  let f: ReturnType<typeof makePayrollFixture>;
  beforeEach(() => {
    f = makePayrollFixture();
  });

  const storedLine = (employeeId: string, accrued: string, paid: string) => ({
    employeeId,
    rateSchemeType: 'percent_normo',
    baseAmount: { toString: () => '0' },
    normoHours: 0,
    linesCount: 1,
    accruedAmount: { toString: () => accrued },
    paidAmount: { toString: () => paid },
    employee: { firstName: 'Іван', lastName: 'Коваль' },
  });

  // guards: BR-PAYR-008
  it('«нараховано» і «виплачено» відомості = сума рядків, округлена до копійки (0.10 + 0.20 = 0.30)', async () => {
    f.prisma.payrollPeriod.findFirst.mockResolvedValueOnce(
      periodRow({
        status: 'PAID',
        lines: [storedLine('e1', '0.1', '0.1'), storedLine('e2', '0.2', '0.2')],
      }),
    );
    const dto = await f.service.findOne(ORG, PID);
    expect(dto.totalAccrued).toBe(0.3); // без округлення було б 0.30000000000000004
    expect(dto.totalPaid).toBe(0.3);
  });

  // guards: BR-PAYR-008
  it('підсумок попереднього розрахунку = сума нарахувань рядків, округлена до копійки', async () => {
    f.prisma.$queryRaw.mockResolvedValueOnce([
      aggRow({ employeeId: 'e1', totalAmount: 0.25 }), // 40% → 0.10
      aggRow({ employeeId: 'e2', totalAmount: 0.5 }), // 40% → 0.20
    ]);
    const res = await f.service.preview(ORG, '2026-09-01', '2026-09-30');
    expect(res.lines.map(l => l.accruedAmount)).toEqual([0.1, 0.2]);
    expect(res.totalAccrued).toBe(0.3);
  });
});

describe('PayrollService.pay — COMPUTED → PAID', () => {
  let f: ReturnType<typeof makePayrollFixture>;
  beforeEach(() => {
    f = makePayrollFixture();
  });

  // guards: BR-PAYR-010
  it.each(['DRAFT', 'PAID', 'CANCELLED'])(
    'статус %s не виплачується → 400, жодного запису (PAID — захист від подвійної виплати)',
    async status => {
      f.prisma.payrollPeriod.findFirst.mockResolvedValueOnce(periodRow({ status }));
      await expect(f.service.pay(ORG, PID, 'user-1', 'reg-1')).rejects.toThrow(
        'Виплатити можна лише розрахований період',
      );
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
      expect(f.cash.createOperation).not.toHaveBeenCalled();
    },
  );

  // guards: BR-PAYR-010
  it('перехід фіксує статус PAID, час і автора виплати — умовно, лише з COMPUTED', async () => {
    f.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce(periodRow({ status: 'COMPUTED' }))
      .mockResolvedValueOnce(periodRow({ status: 'PAID' }));

    await f.service.pay(ORG, PID, 'user-1');

    expect(f.tx.payrollPeriod.updateMany).toHaveBeenCalledWith({
      where: { id: PID, orgId: ORG, status: 'COMPUTED' },
      data: { status: 'PAID', paidAt: expect.any(Date), paidBy: 'user-1' },
    });
  });

  // guards: BR-PAYR-010
  it('виплачене := нараховане — для рядків САМЕ цієї відомості цієї організації', async () => {
    f.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce(periodRow({ status: 'COMPUTED' }))
      .mockResolvedValueOnce(periodRow({ status: 'PAID' }));

    await f.service.pay(ORG, PID, 'user-1');

    expect(f.tx.$executeRaw).toHaveBeenCalledTimes(1);
    const text = sqlText(f.tx.$executeRaw);
    expect(text).toContain('UPDATE payroll_lines SET "paidAmount" = "accruedAmount"');
    expect(text).toContain('WHERE "orgId" = ?::uuid AND "periodId" = ?::uuid');
    expect(sqlValues(f.tx.$executeRaw)).toEqual([ORG, PID]);
  });

  // guards: BR-PAYR-010
  it('програна гонка за виплату → 400 з текстом; суми не проставляються, каса не чіпається', async () => {
    f.prisma.payrollPeriod.findFirst.mockResolvedValueOnce(periodRow({ status: 'COMPUTED' }));
    f.prisma.payrollLine.findMany.mockResolvedValueOnce([{ employeeId: 'e1', accruedAmount: 300 }]);
    f.tx.payrollPeriod.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(f.service.pay(ORG, PID, 'user-1', 'reg-1')).rejects.toThrow(
      'Період уже виплачено або змінено іншим користувачем',
    );
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
    expect(f.cash.createOperation).not.toHaveBeenCalled();
  });
});

describe('PayrollService.pay — каса', () => {
  let f: ReturnType<typeof makePayrollFixture>;
  beforeEach(() => {
    f = makePayrollFixture();
    f.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce(periodRow({ status: 'COMPUTED' }))
      .mockResolvedValueOnce(periodRow({ status: 'PAID' }));
  });

  // guards: BR-PAYR-011
  it('без каси — лише фіксація виплати: касових операцій немає, хоч нарахування є', async () => {
    f.prisma.payrollLine.findMany.mockResolvedValueOnce([
      { employeeId: 'e1', accruedAmount: 300 },
      { employeeId: 'e2', accruedAmount: 200 },
    ]);

    await f.service.pay(ORG, PID, 'user-1');

    expect(f.cash.createOperation).not.toHaveBeenCalled();
    expect(f.tx.$executeRaw).toHaveBeenCalledTimes(1); // виплата все одно зафіксована
  });

  // guards: BR-PAYR-011
  it('з касою — кожному рівно його нараховане (Decimal → число), від імені того, хто виплачує', async () => {
    f.prisma.payrollLine.findMany.mockResolvedValueOnce([
      { employeeId: 'e1', accruedAmount: { toString: () => '1234.56' } },
      { employeeId: 'e2', accruedAmount: { toString: () => '0.01' } },
    ]);

    await f.service.pay(ORG, PID, 'user-1', 'reg-1');

    const sent = f.cash.createOperation.mock.calls.map(c => c[1] as Record<string, unknown>);
    expect(sent).toEqual([
      {
        cashRegisterId: 'reg-1',
        direction: 'OUT',
        amount: 1234.56,
        reason: 'PAYROLL',
        employeeId: 'e1',
        documentType: 'PayrollPeriod',
        documentId: PID,
        createdBy: 'user-1',
      },
      {
        cashRegisterId: 'reg-1',
        direction: 'OUT',
        amount: 0.01,
        reason: 'PAYROLL',
        employeeId: 'e2',
        documentType: 'PayrollPeriod',
        documentId: PID,
        createdBy: 'user-1',
      },
    ]);
  });

  // guards: BR-PAYR-011
  it('касова видача йде ПІСЛЯ захоплення статусу, у тій самій транзакції', async () => {
    f.prisma.payrollLine.findMany.mockResolvedValueOnce([{ employeeId: 'e1', accruedAmount: 300 }]);

    await f.service.pay(ORG, PID, 'user-1', 'reg-1');

    expect(f.cash.createOperation.mock.calls[0]![2]).toBe(f.tx);
    expect(f.tx.payrollPeriod.updateMany.mock.invocationCallOrder[0]!).toBeLessThan(
      f.cash.createOperation.mock.invocationCallOrder[0]!,
    );
  });
});

describe('PayrollService.remove — що можна відкинути', () => {
  let f: ReturnType<typeof makePayrollFixture>;
  beforeEach(() => {
    f = makePayrollFixture();
  });

  // guards: BR-PAYR-012
  it('CANCELLED видаляється так само, як DRAFT і COMPUTED (м’яко)', async () => {
    f.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({ status: 'CANCELLED' });
    await f.service.remove(ORG, PID, 'user-1');
    expect(f.prisma.payrollPeriod.updateMany).toHaveBeenCalledWith({
      where: { id: PID, orgId: ORG, deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
  });

  // guards: BR-PAYR-012
  it('виплачена відомість → 400 з текстом «Не можна видалити виплачений період»', async () => {
    f.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({ status: 'PAID' });
    await expect(f.service.remove(ORG, PID, 'user-1')).rejects.toThrow(
      'Не можна видалити виплачений період',
    );
    expect(f.prisma.payrollPeriod.updateMany).not.toHaveBeenCalled();
  });

  // guards: BR-PAYR-012
  it('видалення не чіпає рядків і розшифровки — лише позначка на самій відомості', async () => {
    f.prisma.payrollPeriod.findFirst.mockResolvedValueOnce({ status: 'COMPUTED' });
    await f.service.remove(ORG, PID, 'user-1');
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.tx.payrollLine.deleteMany).not.toHaveBeenCalled();
    expect(f.tx.payrollLineWorkOrder.deleteMany).not.toHaveBeenCalled();
  });

  it('відомості немає → 404, нічого не позначається', async () => {
    f.prisma.payrollPeriod.findFirst.mockResolvedValueOnce(null);
    await expect(f.service.remove(ORG, PID, 'user-1')).rejects.toThrow(NotFoundException);
    expect(f.prisma.payrollPeriod.updateMany).not.toHaveBeenCalled();
  });
});
