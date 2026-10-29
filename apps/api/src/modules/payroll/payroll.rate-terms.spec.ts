/**
 * Умови схеми й нараховане по наряду в розшифровці (BR-PAYR-016): знімок параметрів схеми при
 * розрахунку, розклад змінної частини рядка по нарядах (найбільший залишок), оклад за період
 * окремо, виведена ставка для рядків без знімка.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  allocateAccruedByWorkOrder,
  computeAccrued,
  deriveRateParams,
  monthShareOfPeriod,
  parseRateScheme,
} from './payroll.calculator';
import { ORG, PID, aggRow, makePayrollFixture, periodRow } from './payroll.spec-fixture';

const cents = (v: number) => Math.round(v * 100);
const sumCents = (values: readonly (number | null)[]) =>
  values.reduce<number>((s, v) => s + cents(v ?? 0), 0);

describe('allocateAccruedByWorkOrder — нараховане по нарядах', () => {
  // guards: BR-PAYR-016
  it('% від суми робіт: пропорційно сумі робіт наряду, Σ = нараховане рядка', () => {
    const res = allocateAccruedByWorkOrder({
      rateSchemeType: 'percent_normo',
      accruedAmount: 1600,
      scheme: parseRateScheme({ type: 'percent_normo', params: { percent: 40 } }),
      periodStart: '2026-10-01',
      periodEnd: '2026-10-29',
      workOrders: [
        { baseAmount: 3000, normoHours: 9 },
        { baseAmount: 1000, normoHours: 1 },
      ],
    });
    expect(res).toEqual({ fixedPart: null, amounts: [1200, 400] });
  });

  // guards: BR-PAYR-016
  it('копійка залишку — наряду з найбільшою дробовою частиною, а не першому', () => {
    // 10 коп. за вагами 3:3:1 → 4,2857 / 4,2857 / 1,4286 → цілі 4+4+1 = 9, залишок 1 коп. —
    // найбільша дробова частина в третього.
    const res = allocateAccruedByWorkOrder({
      rateSchemeType: 'percent_normo',
      accruedAmount: 0.1,
      scheme: null,
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      workOrders: [
        { baseAmount: 3, normoHours: 0 },
        { baseAmount: 3, normoHours: 0 },
        { baseAmount: 1, normoHours: 0 },
      ],
    });
    expect(res.amounts).toEqual([0.04, 0.04, 0.02]);
  });

  // guards: BR-PAYR-016
  it('рівні дробові частини — копійки йдуть по порядку нарядів (100 коп. на три → 34/33/33)', () => {
    const res = allocateAccruedByWorkOrder({
      rateSchemeType: 'percent_normo',
      accruedAmount: 1,
      scheme: null,
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      workOrders: [
        { baseAmount: 500, normoHours: 0 },
        { baseAmount: 500, normoHours: 0 },
        { baseAmount: 500, normoHours: 0 },
      ],
    });
    expect(res.amounts).toEqual([0.34, 0.33, 0.33]);
  });

  // guards: BR-PAYR-016
  it('Σ по нарядах = нараховане до копійки на 500 випадкових рядках (% від суми робіт)', () => {
    let seed = 20261029;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let n = 0; n < 500; n++) {
      const workOrders = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => ({
        baseAmount: Math.round(rnd() * 5_000_000) / 100,
        normoHours: Math.round(rnd() * 400) / 10,
      }));
      const percent = Math.round(rnd() * 6000) / 100;
      const scheme = parseRateScheme({ type: 'percent_normo', params: { percent } });
      const baseAmount = workOrders.reduce((s, w) => s + w.baseAmount, 0);
      const accrued = computeAccrued(scheme, { baseAmount, normoHours: 0 }, 1);
      const res = allocateAccruedByWorkOrder({
        rateSchemeType: 'percent_normo',
        accruedAmount: accrued,
        scheme,
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        workOrders,
      });
      expect(sumCents(res.amounts!)).toBe(cents(accrued));
      expect(res.amounts!.every(a => a >= 0 && cents(a) / 100 === a)).toBe(true);
    }
  });

  // guards: BR-PAYR-016
  it('за нормо-годину: пропорційно нормо-годинам, сума робіт не впливає', () => {
    const res = allocateAccruedByWorkOrder({
      rateSchemeType: 'per_normo_hour',
      accruedAmount: 1000,
      scheme: parseRateScheme({ type: 'per_normo_hour', params: { ratePerHour: 250 } }),
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      workOrders: [
        { baseAmount: 9000, normoHours: 1 },
        { baseAmount: 100, normoHours: 3 },
      ],
    });
    expect(res).toEqual({ fixedPart: null, amounts: [250, 750] });
  });

  // guards: BR-PAYR-016, BR-PAYR-006
  it('оклад + бонус: оклад за частку періоду окремо, по нарядах — лише бонус від суми робіт', () => {
    const scheme = parseRateScheme({
      type: 'fixed_plus_bonus',
      params: { fixedMonthly: 30_000, bonusPercent: 10 },
    });
    const workOrders = [
      { baseAmount: 1000, normoHours: 2 },
      { baseAmount: 3000, normoHours: 1 },
    ];
    // 01–07 вересня → 7/30 окладу = 7000; бонус 10 % від 4000 = 400.
    const accrued = computeAccrued(
      scheme,
      { baseAmount: 4000, normoHours: 3 },
      monthShareOfPeriod('2026-09-01', '2026-09-07'),
    );
    expect(accrued).toBe(7400);

    const res = allocateAccruedByWorkOrder({
      rateSchemeType: 'fixed_plus_bonus',
      accruedAmount: accrued,
      scheme,
      periodStart: '2026-09-01',
      periodEnd: '2026-09-07',
      workOrders,
    });
    expect(res).toEqual({ fixedPart: 7000, amounts: [100, 300] });
  });

  // guards: BR-PAYR-016
  it('оклад + бонус без знімка умов: оклад невідомий → розкладу немає', () => {
    const res = allocateAccruedByWorkOrder({
      rateSchemeType: 'fixed_plus_bonus',
      accruedAmount: 7400,
      scheme: null,
      periodStart: '2026-09-01',
      periodEnd: '2026-09-07',
      workOrders: [{ baseAmount: 4000, normoHours: 3 }],
    });
    expect(res).toEqual({ fixedPart: null, amounts: null });
  });

  // guards: BR-PAYR-016
  it('від’ємна сума робіт наряду (повернення) — вага 0: від’ємного «нараховано» по наряду немає', () => {
    // База рядка 2000 (3000 − 1000), 40 % → 800; уся сума — наряду з додатною базою.
    const res = allocateAccruedByWorkOrder({
      rateSchemeType: 'percent_normo',
      accruedAmount: 800,
      scheme: parseRateScheme({ type: 'percent_normo', params: { percent: 40 } }),
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      workOrders: [
        { baseAmount: -1000, normoHours: 0 },
        { baseAmount: 3000, normoHours: 0 },
      ],
    });
    expect(res.amounts).toEqual([0, 800]);
  });

  // guards: BR-PAYR-016
  it('бази немає зовсім, а нараховане є (розбіжні дані) — порівну, Σ = нараховане', () => {
    const res = allocateAccruedByWorkOrder({
      rateSchemeType: 'percent_normo',
      accruedAmount: 1,
      scheme: null,
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      workOrders: [
        { baseAmount: 0, normoHours: 0 },
        { baseAmount: 0, normoHours: 0 },
        { baseAmount: 0, normoHours: 0 },
      ],
    });
    expect(res.amounts).toEqual([0.34, 0.33, 0.33]);
  });

  // guards: BR-PAYR-016, BR-PAYR-006
  it('оклад + бонус: оклад за період + Σ по нарядах = нараховане до копійки на неповних місяцях', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let n = 0; n < 300; n++) {
      const day = 1 + Math.floor(rnd() * 28);
      const periodStart = `2026-10-${String(day).padStart(2, '0')}`;
      const periodEnd = `2026-10-${String(day + Math.floor(rnd() * (31 - day))).padStart(2, '0')}`;
      const scheme = parseRateScheme({
        type: 'fixed_plus_bonus',
        params: {
          fixedMonthly: Math.round(rnd() * 5_000_000) / 100,
          bonusPercent: Math.round(rnd() * 3000) / 100,
        },
      });
      const workOrders = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => ({
        baseAmount: Math.round(rnd() * 2_000_000) / 100,
        normoHours: 0,
      }));
      const baseAmount = workOrders.reduce((s, w) => s + w.baseAmount, 0);
      const accrued = computeAccrued(
        scheme,
        { baseAmount, normoHours: 0 },
        monthShareOfPeriod(periodStart, periodEnd),
      );
      const res = allocateAccruedByWorkOrder({
        rateSchemeType: 'fixed_plus_bonus',
        accruedAmount: accrued,
        scheme,
        periodStart,
        periodEnd,
        workOrders,
      });
      expect(cents(res.fixedPart!) + sumCents(res.amounts!)).toBe(cents(accrued));
      expect(res.amounts!.every(a => a >= 0)).toBe(true);
    }
  });
});

describe('deriveRateParams — ставка з підсумку рядка без знімка', () => {
  // guards: BR-PAYR-016
  it('% від суми робіт: нараховано ÷ сума робіт × 100, 2 знаки', () => {
    expect(
      deriveRateParams('percent_normo', {
        accruedAmount: 64388.64,
        baseAmount: 160971.6,
        normoHours: 120,
      }),
    ).toEqual({ percent: 40 });
    expect(
      deriveRateParams('percent_normo', { accruedAmount: 100, baseAmount: 300, normoHours: 0 }),
    ).toEqual({ percent: 33.33 });
  });

  // guards: BR-PAYR-016
  it('за нормо-годину: нараховано ÷ нормо-години, 2 знаки', () => {
    expect(
      deriveRateParams('per_normo_hour', { accruedAmount: 1000, baseAmount: 9, normoHours: 3 }),
    ).toEqual({ ratePerHour: 333.33 });
  });

  // guards: BR-PAYR-016
  it('база 0, оклад + бонус і невідома схема → null', () => {
    expect(
      deriveRateParams('percent_normo', { accruedAmount: 0, baseAmount: 0, normoHours: 5 }),
    ).toBeNull();
    expect(
      deriveRateParams('per_normo_hour', { accruedAmount: 0, baseAmount: 500, normoHours: 0 }),
    ).toBeNull();
    expect(
      deriveRateParams('fixed_plus_bonus', {
        accruedAmount: 7400,
        baseAmount: 4000,
        normoHours: 3,
      }),
    ).toBeNull();
    expect(
      deriveRateParams('unknown', { accruedAmount: 0, baseAmount: 4000, normoHours: 3 }),
    ).toBeNull();
  });
});

/** Рядок відомості, як його повертає findFirst з include lines.workOrders. */
function lineRow(over: Record<string, unknown> = {}) {
  return {
    employeeId: 'e1',
    rateSchemeType: 'percent_normo',
    baseAmount: 4000,
    normoHours: 10,
    linesCount: 3,
    accruedAmount: 1600,
    paidAmount: 0,
    rateParams: { percent: 40 },
    employee: { firstName: 'Петя', lastName: 'Пупкін' },
    workOrders: [
      {
        workOrderId: 'wo-1',
        workOrderNumber: 'НРД-1',
        vehicleName: null,
        worksCount: 2,
        normoHours: 9,
        baseAmount: 3000,
      },
      {
        workOrderId: 'wo-2',
        workOrderNumber: 'НРД-2',
        vehicleName: null,
        worksCount: 1,
        normoHours: 1,
        baseAmount: 1000,
      },
    ],
    ...over,
  };
}

describe('PayrollService.findOne — умови схеми й нараховане по наряду', () => {
  let f: ReturnType<typeof makePayrollFixture>;
  beforeEach(() => {
    f = makePayrollFixture();
  });

  const findLine = async (line: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    f.prisma.payrollPeriod.findFirst.mockResolvedValueOnce(
      periodRow({ status: 'COMPUTED', lines: [line], ...over }),
    );
    const dto = await f.service.findOne(ORG, PID);
    return dto.lines![0];
  };

  // guards: BR-PAYR-016
  it('знімок: умови зі знімка без «≈», нараховане по нарядах у сумі = нараховане рядка', async () => {
    const line = await findLine(lineRow());

    expect(line.rateParams).toEqual({ percent: 40 });
    expect(line.rateDerived).toBe(false);
    expect(line.fixedPart).toBeUndefined();
    expect(line.workOrders!.map(w => w.accruedAmount)).toEqual([1200, 400]);
    // Знімок, а не поточна ставка: схему працівника розшифровка не читає взагалі.
    expect(f.prisma.employee.findMany).not.toHaveBeenCalled();
  });

  // guards: BR-PAYR-016
  it('знімок важить більше за підсумок: 40 % у знімку не перераховується з нарахованого', async () => {
    const line = await findLine(lineRow({ accruedAmount: 1500, rateParams: { percent: 40 } }));
    expect(line.rateParams).toEqual({ percent: 40 });
    expect(line.rateDerived).toBe(false);
    expect(sumCents(line.workOrders!.map(w => w.accruedAmount))).toBe(150_000);
  });

  // guards: BR-PAYR-016
  it('без знімка (% від суми робіт): ставка виведена з підсумку, rateDerived, наряди розкладено', async () => {
    const line = await findLine(lineRow({ rateParams: null }));

    expect(line.rateParams).toEqual({ percent: 40 });
    expect(line.rateDerived).toBe(true);
    expect(line.workOrders!.map(w => w.accruedAmount)).toEqual([1200, 400]);
  });

  // guards: BR-PAYR-016
  it('без знімка (за нормо-годину): ставка = нараховано ÷ нормо-години', async () => {
    const line = await findLine(
      lineRow({ rateSchemeType: 'per_normo_hour', accruedAmount: 2500, rateParams: null }),
    );
    expect(line.rateParams).toEqual({ ratePerHour: 250 });
    expect(line.rateDerived).toBe(true);
    expect(line.workOrders!.map(w => w.accruedAmount)).toEqual([2250, 250]);
  });

  // guards: BR-PAYR-016
  it('зіпсований знімок (не та форма) → як без знімка: ставка з підсумку', async () => {
    const line = await findLine(lineRow({ rateParams: { ratePerHour: 'x' } }));
    expect(line.rateParams).toEqual({ percent: 40 });
    expect(line.rateDerived).toBe(true);
  });

  // guards: BR-PAYR-016
  it('оклад + бонус зі знімком: оклад за період окремо, наряди — лише бонус', async () => {
    const line = await findLine(
      lineRow({
        rateSchemeType: 'fixed_plus_bonus',
        accruedAmount: 7400,
        rateParams: { fixedMonthly: 30_000, bonusPercent: 10 },
      }),
      {
        periodStart: new Date('2026-09-01T00:00:00Z'),
        periodEnd: new Date('2026-09-07T00:00:00Z'),
      },
    );

    expect(line.rateParams).toEqual({ fixedMonthly: 30_000, bonusPercent: 10 });
    expect(line.rateDerived).toBe(false);
    expect(line.fixedPart).toBe(7000);
    expect(line.workOrders!.map(w => w.accruedAmount)).toEqual([300, 100]);
    expect(line.fixedPart! * 100 + sumCents(line.workOrders!.map(w => w.accruedAmount))).toBe(
      740_000,
    );
  });

  // guards: BR-PAYR-016
  it('оклад + бонус без знімка: умов немає (null), нараховане по нарядах не віддається', async () => {
    const line = await findLine(
      lineRow({ rateSchemeType: 'fixed_plus_bonus', accruedAmount: 7400, rateParams: null }),
    );

    expect(line.rateParams).toBeNull();
    expect(line.rateDerived).toBe(false);
    expect(line.fixedPart).toBeUndefined();
    expect(line.workOrders!.map(w => w.accruedAmount)).toEqual([null, null]);
  });

  // guards: BR-PAYR-016
  it('список періодів (без розшифровки) теж несе умови рядка', async () => {
    f.prisma.payrollPeriod.findMany.mockResolvedValueOnce([
      periodRow({
        status: 'COMPUTED',
        lines: [{ ...lineRow({ rateParams: null }), workOrders: undefined }],
      }),
    ]);
    f.prisma.payrollPeriod.count.mockResolvedValueOnce(1);

    const page = await f.service.findAll(ORG);
    const line = page.items[0].lines![0];
    expect(line.rateParams).toEqual({ percent: 40 });
    expect(line.rateDerived).toBe(true);
    expect(line.workOrders).toBeUndefined();
  });
});

describe('PayrollService.compute — знімок умов схеми', () => {
  let f: ReturnType<typeof makePayrollFixture>;
  beforeEach(() => {
    f = makePayrollFixture();
    f.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce(periodRow({ status: 'DRAFT' }))
      .mockResolvedValueOnce(periodRow({ status: 'COMPUTED' }));
  });

  const createdData = (call = 0) =>
    (f.tx.payrollLine.create.mock.calls[call][0] as { data: Record<string, unknown> }).data;

  // guards: BR-PAYR-016
  it('пише в рядок параметри поточної схеми працівника — лише її поля', async () => {
    f.prisma.$queryRaw
      .mockResolvedValueOnce([
        aggRow({
          employeeId: 'e1',
          rateScheme: { type: 'per_normo_hour', params: { ratePerHour: 250, note: 'зайве' } },
        }),
        aggRow({
          employeeId: 'e2',
          rateScheme: { type: 'percent_normo', params: { percent: 40 } },
        }),
      ])
      .mockResolvedValueOnce([]);

    await f.service.compute(ORG, PID, 'user-1');

    expect(createdData(0).rateParams).toEqual({ ratePerHour: 250 });
    expect(createdData(1).rateParams).toEqual({ percent: 40 });
  });

  // guards: BR-PAYR-016, BR-PAYR-007
  it('немає схеми чи вона невалідна — знімка немає (NULL у колонці), рядок усе одно пишеться', async () => {
    f.prisma.$queryRaw
      .mockResolvedValueOnce([aggRow({ employeeId: 'e1', rateScheme: null })])
      .mockResolvedValueOnce([]);

    await f.service.compute(ORG, PID, 'user-1');

    expect(f.tx.payrollLine.create).toHaveBeenCalledTimes(1);
    expect(createdData()).not.toHaveProperty('rateParams');
    expect(createdData().rateSchemeType).toBe('unknown');
  });
});
