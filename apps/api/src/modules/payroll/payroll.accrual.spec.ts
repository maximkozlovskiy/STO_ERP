/**
 * Хто потрапляє у відомість і скільки отримує окладу (BR-PAYR-001, BR-PAYR-006, BR-PAYR-015).
 * Рішення власника 2026-10-08: наряд входить лише в одну відомість; оклад — пропорційно дням
 * періоду; працівник на окладі без робіт теж отримує рядок.
 *
 * Сам SQL «наряд уже в іншій відомості» тут не виконується ($queryRaw — мок): unit-кейси
 * стережуть, що умова Є в обох агрегатах і з якими параметрами. Результат на живій БД —
 * payroll.accrual.integration.spec.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { computeAccrued, monthShareOfPeriod, parseRateScheme } from './payroll.calculator';
import {
  BRANCH,
  ORG,
  PID,
  aggRow,
  makePayrollFixture,
  periodRow,
  sqlValues,
} from './payroll.spec-fixture';

const SALARY = { type: 'fixed_plus_bonus', params: { fixedMonthly: 30_000, bonusPercent: 10 } };

describe('monthShareOfPeriod — частка місяця, яку покриває період', () => {
  // guards: BR-PAYR-006
  it.each([
    ['2026-09-01', '2026-09-30', 1, 'повний 30-денний місяць'],
    ['2026-10-01', '2026-10-31', 1, 'повний 31-денний місяць'],
    ['2026-02-01', '2026-02-28', 1, 'повний лютий'],
    ['2026-09-01', '2026-09-07', 7 / 30, 'тиждень у вересні'],
    ['2026-09-15', '2026-09-15', 1 / 30, 'один день (обидві межі включно)'],
    ['2026-09-25', '2026-10-05', 6 / 30 + 5 / 31, 'через межу місяців'],
    ['2026-09-01', '2026-10-31', 2, 'два повні місяці'],
    ['2026-12-20', '2027-01-10', 12 / 31 + 10 / 31, 'через межу року'],
    ['2028-02-01', '2028-02-29', 1, 'високосний лютий'],
  ])('%s … %s → %f (%s)', (from, to, expected) => {
    expect(monthShareOfPeriod(from, to)).toBeCloseTo(expected, 10);
  });

  // guards: BR-PAYR-006
  it('чотири тижневі відомості вересня + хвіст разом дають рівно один місяць, а не чотири', () => {
    const parts = [
      ['2026-09-01', '2026-09-07'],
      ['2026-09-08', '2026-09-14'],
      ['2026-09-15', '2026-09-21'],
      ['2026-09-22', '2026-09-28'],
      ['2026-09-29', '2026-09-30'],
    ].map(([from, to]) => monthShareOfPeriod(from, to));
    expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('початок пізніше кінця або невалідна дата → 0', () => {
    expect(monthShareOfPeriod('2026-09-30', '2026-09-01')).toBe(0);
    expect(monthShareOfPeriod('сміття', '2026-09-01')).toBe(0);
  });
});

describe('computeAccrued — оклад пропорційно частці місяця', () => {
  const scheme = parseRateScheme(SALARY);

  // guards: BR-PAYR-006
  it('тиждень у 30-денному місяці: оклад 30 000 × 7/30 = 7 000, бонус від бази — повністю', () => {
    const share = monthShareOfPeriod('2026-09-01', '2026-09-07');
    expect(computeAccrued(scheme, { baseAmount: 0, normoHours: 0 }, share)).toBe(7000);
    expect(computeAccrued(scheme, { baseAmount: 5000, normoHours: 0 }, share)).toBe(7500);
  });

  // guards: BR-PAYR-006
  it('частка впливає ЛИШЕ на фіксовану частину: відсоткова й погодинна схеми від неї не залежать', () => {
    const percent = parseRateScheme({ type: 'percent_normo', params: { percent: 40 } });
    const perHour = parseRateScheme({ type: 'per_normo_hour', params: { ratePerHour: 150 } });
    expect(computeAccrued(percent, { baseAmount: 1000, normoHours: 0 }, 0.1)).toBe(400);
    expect(computeAccrued(perHour, { baseAmount: 0, normoHours: 2 }, 0.1)).toBe(300);
  });

  // guards: BR-PAYR-006, BR-PAYR-008
  it('оклад за частку округлюється до копійки один раз (10 000 × 1/31 = 322,58)', () => {
    const s = parseRateScheme({
      type: 'fixed_plus_bonus',
      params: { fixedMonthly: 10_000, bonusPercent: 0 },
    });
    expect(computeAccrued(s, { baseAmount: 0, normoHours: 0 }, 1 / 31)).toBe(322.58);
  });
});

describe('PayrollService — наряд входить лише в одну відомість', () => {
  let f: ReturnType<typeof makePayrollFixture>;
  beforeEach(() => {
    f = makePayrollFixture();
  });

  /** Остання інтерполяція агрегату — фрагмент «наряд уже в іншій відомості». */
  const exclusion = (call: number) => {
    const values = sqlValues(f.prisma.$queryRaw, call);
    return values[values.length - 1] as { strings: string[]; values: unknown[] };
  };
  const flat = (frag: { values: unknown[] }): unknown[] =>
    frag.values.flatMap(v =>
      v && typeof v === 'object' && 'values' in v ? (v as { values: unknown[] }).values : [v],
    );

  // guards: BR-PAYR-015
  it('обидва агрегати розрахунку несуть NOT EXISTS по розшифровці інших відомостей COMPUTED/PAID', async () => {
    f.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce(periodRow({ status: 'DRAFT' }))
      .mockResolvedValueOnce(periodRow({ status: 'COMPUTED' }));

    await f.service.compute(ORG, PID, 'user-1');

    expect(f.prisma.$queryRaw).toHaveBeenCalledTimes(2);
    for (const call of [0, 1]) {
      const sql = exclusion(call).strings.join('?').replace(/\s+/g, ' ');
      expect(sql).toContain('NOT EXISTS');
      expect(sql).toContain('payroll_line_work_orders');
      expect(sql).toContain('plw."workOrderId" = wo.id');
      expect(sql).toContain('pl."employeeId" = wol."employeeId"');
      expect(sql).toContain('pp."deletedAt" IS NULL');
      expect(sql).toContain("ARRAY['COMPUTED','PAID']");
      // організація і поточна відомість (власний знімок «чужим» не вважається)
      expect(flat(exclusion(call))).toEqual([ORG, PID]);
    }
  });

  // guards: BR-PAYR-015
  it('попередній розрахунок застосовує ту саму умову (показує, що реально нарахується), без «поточної відомості»', async () => {
    await f.service.preview(ORG, '2026-09-01', '2026-09-30');

    const sql = exclusion(0).strings.join('?');
    expect(sql).toContain('NOT EXISTS');
    expect(flat(exclusion(0))).toEqual([ORG]);
  });

  // guards: BR-PAYR-015
  it('розрахунок: блокування організації → захоплення статусу → чистка старих рядків → агрегати, усе в одній транзакції', async () => {
    f.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce(periodRow({ status: 'DRAFT' }))
      .mockResolvedValueOnce(periodRow({ status: 'COMPUTED' }));

    await f.service.compute(ORG, PID, 'user-1');

    const order = (mock: { mock: { invocationCallOrder: number[] } }) =>
      mock.mock.invocationCallOrder[0];
    const lockSql = (f.tx.$executeRaw.mock.calls[0][0] as string[]).join('?');
    expect(lockSql).toContain('pg_advisory_xact_lock');
    expect(f.tx.$executeRaw.mock.calls[0][1]).toBe(`payroll:${ORG}`);
    expect(order(f.tx.$executeRaw)).toBeLessThan(order(f.tx.payrollPeriod.updateMany));
    expect(order(f.tx.payrollPeriod.updateMany)).toBeLessThan(order(f.tx.payrollLine.deleteMany));
    expect(order(f.tx.payrollLine.deleteMany)).toBeLessThan(order(f.prisma.$queryRaw));
  });

  // guards: BR-PAYR-015
  it('програна гонка за статус → агрегати не запускаються взагалі', async () => {
    f.prisma.payrollPeriod.findFirst.mockResolvedValueOnce(periodRow({ status: 'DRAFT' }));
    f.tx.payrollPeriod.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(f.service.compute(ORG, PID, 'user-1')).rejects.toThrow(
      'Період уже розраховано або змінено іншим користувачем',
    );
    expect(f.prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('PayrollService — працівник на окладі без робіт за період', () => {
  let f: ReturnType<typeof makePayrollFixture>;
  beforeEach(() => {
    f = makePayrollFixture();
  });

  const salaried = (over: Record<string, unknown> = {}) => ({
    id: 'e-salary',
    firstName: 'Олена',
    lastName: 'Бондар',
    rateScheme: SALARY,
    ...over,
  });

  // guards: BR-PAYR-001, BR-PAYR-006
  it('отримує рядок: база 0, нормо-години 0, оклад за часткою періоду', async () => {
    f.prisma.employee.findMany.mockResolvedValueOnce([salaried()]);

    const res = await f.service.preview(ORG, '2026-09-01', '2026-09-07');

    expect(res.lines).toEqual([
      {
        employeeId: 'e-salary',
        employeeName: 'Бондар Олена',
        rateSchemeType: 'fixed_plus_bonus',
        baseAmount: 0,
        normoHours: 0,
        linesCount: 0,
        accruedAmount: 7000,
      },
    ]);
    expect(res.totalAccrued).toBe(7000);
  });

  // guards: BR-PAYR-001
  it('працівники на відсотку чи погодинній ставці без робіт рядка НЕ отримують', async () => {
    f.prisma.employee.findMany.mockResolvedValueOnce([
      salaried({ id: 'e-percent', rateScheme: { type: 'percent_normo', params: { percent: 40 } } }),
      salaried({
        id: 'e-hour',
        rateScheme: { type: 'per_normo_hour', params: { ratePerHour: 150 } },
      }),
      salaried({ id: 'e-broken', rateScheme: null }),
    ]);

    const res = await f.service.preview(ORG, '2026-09-01', '2026-09-30');

    expect(res.lines).toEqual([]);
  });

  // guards: BR-PAYR-001
  it('хто вже має рядок із виробітком — вдруге не додається (notIn по працівниках агрегату)', async () => {
    f.prisma.$queryRaw.mockResolvedValueOnce([aggRow({ employeeId: 'e1', rateScheme: SALARY })]);

    const res = await f.service.preview(ORG, '2026-09-01', '2026-09-30');

    expect(res.lines).toHaveLength(1);
    expect(res.lines[0].accruedAmount).toBe(30_500); // оклад 30 000 + 10% від 5 000
    expect(f.prisma.employee.findMany.mock.calls[0][0].where.id).toEqual({ notIn: ['e1'] });
  });

  // guards: BR-PAYR-001, BR-PAYR-013
  it('вибірка: своя організація, не видалені, активні, прийняті до кінця періоду й не звільнені до початку', async () => {
    await f.service.preview(ORG, '2026-09-01', '2026-09-30');

    const where = f.prisma.employee.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ orgId: ORG, deletedAt: null, status: 'ACTIVE' });
    expect(where.AND).toEqual([
      { OR: [{ dateOfHire: null }, { dateOfHire: { lte: new Date('2026-09-30T23:59:59.999Z') } }] },
      { OR: [{ dateOfFire: null }, { dateOfFire: { gte: new Date('2026-09-01T00:00:00.000Z') } }] },
    ]);
  });

  // guards: BR-PAYR-003
  it('відомість по філії: лише прив’язані до цієї філії або з доступом до всіх', async () => {
    await f.service.preview(ORG, '2026-09-01', '2026-09-30', BRANCH);

    const where = f.prisma.employee.findMany.mock.calls[0][0].where;
    expect(where.AND[2]).toEqual({
      OR: [{ allBranches: true }, { employeeBranches: { some: { branchId: BRANCH } } }],
    });
  });

  // guards: BR-PAYR-001
  it('розрахунок записує рядок окладника в знімок відомості (без розшифровки по нарядах)', async () => {
    f.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce(
        periodRow({ status: 'DRAFT', periodEnd: new Date('2026-09-07T00:00:00Z') }),
      )
      .mockResolvedValueOnce(periodRow({ status: 'COMPUTED' }));
    f.prisma.employee.findMany.mockResolvedValueOnce([salaried()]);

    await f.service.compute(ORG, PID, 'user-1');

    expect(f.tx.payrollLine.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orgId: ORG,
        periodId: PID,
        employeeId: 'e-salary',
        baseAmount: 0,
        linesCount: 0,
        accruedAmount: 7000,
      }),
      select: { id: true },
    });
    expect(f.tx.payrollLineWorkOrder.createMany).not.toHaveBeenCalled();
  });
});
