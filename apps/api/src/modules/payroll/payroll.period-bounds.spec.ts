/**
 * Межі періоду й філія (BR-PAYR-002, BR-PAYR-003): що саме сервіс передає у сирий SQL
 * агрегату. Сам SQL (джерело, статуси нарядів) unit-тестом не перевіряється — див. дос'є.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  BRANCH,
  ORG,
  PID,
  makePayrollFixture,
  periodRow,
  sqlText,
  sqlValues,
} from './payroll.spec-fixture';

const datesOf = (values: unknown[]): string[] =>
  values.filter((v): v is Date => v instanceof Date).map(d => d.toISOString());

/** Значення, вкладені у фрагмент Prisma.sql / Prisma.empty (остання інтерполяція агрегату). */
const fragmentValues = (values: unknown[]): unknown[] =>
  (values[values.length - 1] as { values: unknown[] }).values;

describe('PayrollService — межі періоду за Києвом', () => {
  let f: ReturnType<typeof makePayrollFixture>;
  beforeEach(() => {
    f = makePayrollFixture();
  });

  // guards: BR-PAYR-002
  it('літній час (UTC+3): 01.09–30.09 → від 31.08 21:00:00.000Z до 30.09 20:59:59.999Z', async () => {
    await f.service.preview(ORG, '2026-09-01', '2026-09-30');
    expect(datesOf(sqlValues(f.prisma.$queryRaw))).toEqual([
      '2026-08-31T21:00:00.000Z',
      '2026-09-30T20:59:59.999Z',
    ]);
  });

  // guards: BR-PAYR-002
  it('зимовий час (UTC+2): 01.01–31.01 → від 31.12 22:00:00.000Z до 31.01 21:59:59.999Z', async () => {
    await f.service.preview(ORG, '2026-01-01', '2026-01-31');
    expect(datesOf(sqlValues(f.prisma.$queryRaw))).toEqual([
      '2025-12-31T22:00:00.000Z',
      '2026-01-31T21:59:59.999Z',
    ]);
  });

  // guards: BR-PAYR-002
  it('період через перехід на літній час (березень): початок за зимовим зсувом, кінець за літнім', async () => {
    await f.service.preview(ORG, '2026-03-01', '2026-03-31');
    expect(datesOf(sqlValues(f.prisma.$queryRaw))).toEqual([
      '2026-02-28T22:00:00.000Z',
      '2026-03-31T20:59:59.999Z',
    ]);
  });

  // guards: BR-PAYR-002
  it('один день (from = to) — це повна київська доба, а не порожній проміжок', async () => {
    await f.service.preview(ORG, '2026-09-15', '2026-09-15');
    expect(datesOf(sqlValues(f.prisma.$queryRaw))).toEqual([
      '2026-09-14T21:00:00.000Z',
      '2026-09-15T20:59:59.999Z',
    ]);
  });

  // guards: BR-PAYR-002
  it('compute бере межі зі збереженого періоду і дає ТІ САМІ межі обом запитам (рядки + розшифровка)', async () => {
    f.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce(periodRow({ status: 'DRAFT' }))
      .mockResolvedValueOnce(periodRow({ status: 'COMPUTED' }));

    await f.service.compute(ORG, PID, 'user-1');

    const expected = ['2026-08-31T21:00:00.000Z', '2026-09-30T20:59:59.999Z'];
    expect(f.prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(datesOf(sqlValues(f.prisma.$queryRaw, 0))).toEqual(expected);
    expect(datesOf(sqlValues(f.prisma.$queryRaw, 1))).toEqual(expected);
  });

  // guards: BR-PAYR-002
  it('межі порівнюються з датою завершення наряду (completedAt), обидві включно', async () => {
    await f.service.preview(ORG, '2026-09-01', '2026-09-30');
    const text = sqlText(f.prisma.$queryRaw);
    expect(text).toContain('wo."completedAt" >= ?');
    expect(text).toContain('wo."completedAt" <= ?');
  });

  // guards: BR-PAYR-002
  it('створення періоду з початком пізніше кінця → 400, запис не створюється', async () => {
    await expect(
      f.service.create(ORG, { periodStart: '2026-09-30', periodEnd: '2026-09-01' }),
    ).rejects.toThrow(BadRequestException);
    expect(f.prisma.payrollPeriod.create).not.toHaveBeenCalled();
  });

  // guards: BR-PAYR-002
  it('попередній розрахунок з початком пізніше кінця → 400 з текстом, агрегат не запускається', async () => {
    await expect(f.service.preview(ORG, '2026-09-30', '2026-09-01')).rejects.toThrow(
      'Дата початку має бути не пізніше дати закінчення',
    );
    expect(f.prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('PayrollService — філія періоду', () => {
  let f: ReturnType<typeof makePayrollFixture>;
  beforeEach(() => {
    f = makePayrollFixture();
  });

  // guards: BR-PAYR-003
  it('без філії — фільтра по філії в агрегаті немає (усі філії організації)', async () => {
    await f.service.preview(ORG, '2026-09-01', '2026-09-30');
    expect(fragmentValues(sqlValues(f.prisma.$queryRaw))).toEqual([]);
    expect(f.prisma.garageBranch.findFirst).not.toHaveBeenCalled();
  });

  // guards: BR-PAYR-003
  it('з філією — агрегат отримує умову по branchId наряду', async () => {
    await f.service.preview(ORG, '2026-09-01', '2026-09-30', BRANCH);
    const values = sqlValues(f.prisma.$queryRaw);
    expect(fragmentValues(values)).toEqual([BRANCH]);
    const fragment = values[values.length - 1] as { strings: string[] };
    expect(fragment.strings.join('?')).toContain('wo."branchId" = ?');
  });

  // guards: BR-PAYR-003
  it('compute застосовує філію ЗБЕРЕЖЕНОГО періоду до рядків і до розшифровки', async () => {
    f.prisma.payrollPeriod.findFirst
      .mockResolvedValueOnce(periodRow({ status: 'DRAFT', branchId: BRANCH }))
      .mockResolvedValueOnce(periodRow({ status: 'COMPUTED', branchId: BRANCH }));

    await f.service.compute(ORG, PID, 'user-1');

    expect(fragmentValues(sqlValues(f.prisma.$queryRaw, 0))).toEqual([BRANCH]);
    expect(fragmentValues(sqlValues(f.prisma.$queryRaw, 1))).toEqual([BRANCH]);
  });

  // guards: BR-PAYR-003
  it('попередній розрахунок по філії, якої немає в організації → 404, агрегат не запускається', async () => {
    f.prisma.garageBranch.findFirst.mockResolvedValueOnce(null);
    await expect(f.service.preview(ORG, '2026-09-01', '2026-09-30', BRANCH)).rejects.toThrow(
      NotFoundException,
    );
    expect(f.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  // guards: BR-PAYR-003
  it('створення періоду по філії, якої немає в організації → 404, запис не створюється', async () => {
    f.prisma.garageBranch.findFirst.mockResolvedValueOnce(null);
    await expect(
      f.service.create(ORG, {
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        branchId: BRANCH,
      }),
    ).rejects.toThrow('Філію не знайдено');
    expect(f.prisma.payrollPeriod.create).not.toHaveBeenCalled();
  });
});
