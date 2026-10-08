import { describe, it, expect } from 'vitest';
import type { VatMode } from '@prisma/client';
import fc from 'fast-check';
import { calcVatOnBase, calcLineVat, plannedWorkOrderTotals, splitWorkOrderTotal } from './vat';
import { money } from './money';

/**
 * A5-money: єдине джерело формули ПДВ. calcVatOnBase (документ-база) має давати ту саму математику,
 * що per-line calcLineVat при qty=1 → сумарний ПДВ рядків = ПДВ на їхню базу (консистентність
 * WorkOrdersService.recalcTotals ↔ invoices lineVatTotals).
 */
describe('calcVatOnBase (A5-money)', () => {
  it('NONE або rate=0 → 0', () => {
    expect(calcVatOnBase(1000, 20, 'NONE' as VatMode)).toBe(0);
    expect(calcVatOnBase(1000, 0, 'EXCLUSIVE' as VatMode)).toBe(0);
  });

  it('EXCLUSIVE → ПДВ зверху (base × rate/100)', () => {
    expect(calcVatOnBase(1000, 20, 'EXCLUSIVE' as VatMode)).toBe(200);
    expect(calcVatOnBase(600, 20, 'EXCLUSIVE' as VatMode)).toBe(120);
  });

  it('INCLUSIVE → виділяє ПДВ із бази (base − base/(1+rate/100))', () => {
    // 1200 з включеним 20% → без ПДВ 1000, ПДВ 200
    expect(calcVatOnBase(1200, 20, 'INCLUSIVE' as VatMode)).toBe(200);
  });

  it('квантує до копійки', () => {
    // 100 EXCLUSIVE 20% = 20.00; дробові — округлення
    expect(calcVatOnBase(33.33, 20, 'EXCLUSIVE' as VatMode)).toBe(6.67);
  });

  it('узгодженість з calcLineVat(qty=1): ПДВ бази = vatAmount рядка', () => {
    for (const [base, rate, mode] of [
      [1000, 20, 'EXCLUSIVE'],
      [1200, 20, 'INCLUSIVE'],
      [777.77, 7, 'EXCLUSIVE'],
    ] as [number, number, VatMode][]) {
      const onBase = calcVatOnBase(base, rate, mode);
      const perLine = calcLineVat(base, 1, rate, mode).vatAmount;
      expect(onBase).toBe(perLine);
    }
  });
});

/**
 * BR-WO-007: сума рядків наряду (`base`) розкладається на «без ПДВ» і «до сплати» за режимом.
 * `totalAmount` — те, що платить клієнт: ПДВ у ньому є завжди, коли він є взагалі.
 */
describe('splitWorkOrderTotal (BR-WO-007)', () => {
  // guards: BR-WO-007
  it('без ПДВ → і «без ПДВ», і «до сплати» = сума рядків', () => {
    const base = money(700);
    const vat = calcVatOnBase(base, 0, 'NONE' as VatMode);

    expect(splitWorkOrderTotal(base, vat, 'NONE' as VatMode)).toEqual({
      totalNet: 700,
      totalAmount: 700,
    });
  });

  // guards: BR-WO-007
  it('ПДВ у ціні → «до сплати» = сума рядків, «без ПДВ» = сума рядків − ПДВ', () => {
    const base = money(1200);
    const vat = calcVatOnBase(base, 20, 'INCLUSIVE' as VatMode); // 200

    expect(splitWorkOrderTotal(base, vat, 'INCLUSIVE' as VatMode)).toEqual({
      totalNet: 1000,
      totalAmount: 1200,
    });
  });

  // guards: BR-WO-007
  it('ПДВ зверху → «без ПДВ» = сума рядків, «до сплати» = сума рядків + ПДВ', () => {
    const base = money(1000);
    const vat = calcVatOnBase(base, 20, 'EXCLUSIVE' as VatMode); // 200

    expect(splitWorkOrderTotal(base, vat, 'EXCLUSIVE' as VatMode)).toEqual({
      totalNet: 1000,
      totalAmount: 1200,
    });
  });

  // guards: BR-WO-007
  it('результат квантовано до копійки (99.99 + 20.00, 100.10 − 16.68 без float-хвоста)', () => {
    const excl = splitWorkOrderTotal(money(99.99), money(20), 'EXCLUSIVE' as VatMode);
    expect(excl.totalAmount).toBe(119.99);
    // 100.1 − 16.68 у float = 83.41999999999999
    const incl = splitWorkOrderTotal(money(100.1), money(16.68), 'INCLUSIVE' as VatMode);
    expect(incl.totalNet).toBe(83.42);
  });

  // guards: BR-WO-007
  it('інваріант: totalNet + ПДВ = totalAmount для будь-якої бази, режиму й ставки', () => {
    const base = fc.integer({ min: 0, max: 1_000_000_00 }).map(c => money(c / 100));
    const mode = fc.constantFrom<VatMode>('NONE', 'EXCLUSIVE', 'INCLUSIVE');
    const rate = fc.constantFrom(0, 7, 14, 20);

    fc.assert(
      fc.property(base, mode, rate, (b, vatMode, vatRate) => {
        const vat = calcVatOnBase(b, vatRate, vatMode);
        const { totalNet, totalAmount } = splitWorkOrderTotal(b, vat, vatMode);

        expect(money(totalNet + vat)).toBe(totalAmount);
        // Сума рядків лишається однією з двох: «до сплати» (ПДВ у ціні / без ПДВ) або «без ПДВ».
        if (vatMode === 'EXCLUSIVE') expect(totalNet).toBe(b);
        else expect(totalAmount).toBe(b);
        expect(totalNet).toBeLessThanOrEqual(totalAmount);
      }),
      { numRuns: 500 },
    );
  });
});

/**
 * BR-WO-007: плановий підсумок кошторису (публічна сторінка, PDF/XLSX/DOCX, SMS).
 * План = totalLabor + totalParts; режим і частка ПДВ беруться з тоталів самого наряду
 * (вони рахуються від факту: totalActualLabor + totalParts).
 */
describe('plannedWorkOrderTotals (BR-WO-007)', () => {
  // guards: BR-WO-007
  it('наряд без ПДВ → плановий підсумок без ПДВ: обидві суми = план', () => {
    // план 1000 + 200, факт 1100 + 200 = 1300 (без ПДВ: totalNet = totalAmount)
    expect(
      plannedWorkOrderTotals({
        totalLabor: 1000,
        totalActualLabor: 1100,
        totalParts: 200,
        totalNet: 1300,
        totalAmount: 1300,
      }),
    ).toEqual({ totalNet: 1200, totalVat: 0, totalAmount: 1200 });
  });

  // guards: BR-WO-007
  it('план = факт → рівно тотали наряду, без повторного округлення', () => {
    // «ПДВ зверху»: 99.99 → ПДВ 20.00 → 119.99 (частка ПДВ не рівно 20%)
    expect(
      plannedWorkOrderTotals({
        totalLabor: 66.66,
        totalActualLabor: 66.66,
        totalParts: 33.33,
        totalNet: 99.99,
        totalAmount: 119.99,
      }),
    ).toEqual({ totalNet: 99.99, totalVat: 20, totalAmount: 119.99 });
    // «ПДВ у ціні»: 700 → ПДВ 116.67, без ПДВ 583.33
    expect(
      plannedWorkOrderTotals({
        totalLabor: 200,
        totalActualLabor: 200,
        totalParts: 500,
        totalNet: 583.33,
        totalAmount: 700,
      }),
    ).toEqual({ totalNet: 583.33, totalVat: 116.67, totalAmount: 700 });
  });

  // guards: BR-WO-007
  it('«ПДВ зверху», план ≠ факт → ПДВ нараховано на ПЛАН: без ПДВ = план, до сплати = план + ПДВ', () => {
    // факт 1300 → наряд 1300 / 260 / 1560; план 1200 → 1200 / 240 / 1440
    expect(
      plannedWorkOrderTotals({
        totalLabor: 1000,
        totalActualLabor: 1100,
        totalParts: 200,
        totalNet: 1300,
        totalAmount: 1560,
      }),
    ).toEqual({ totalNet: 1200, totalVat: 240, totalAmount: 1440 });
  });

  // guards: BR-WO-007
  it('«ПДВ у ціні», план ≠ факт → до сплати = план, ПДВ виділено з плану', () => {
    // факт 1300 з ПДВ у ціні → наряд 1083.33 / 216.67 / 1300; план 1200 → 1000 / 200 / 1200
    expect(
      plannedWorkOrderTotals({
        totalLabor: 1000,
        totalActualLabor: 1100,
        totalParts: 200,
        totalNet: 1083.33,
        totalAmount: 1300,
      }),
    ).toEqual({ totalNet: 1000, totalVat: 200, totalAmount: 1200 });
  });

  // guards: BR-WO-007
  it('наряд «старої моделі» (організація з ПДВ, але totalNet = totalAmount) → ПДВ 0, сума = план', () => {
    expect(
      plannedWorkOrderTotals({
        totalLabor: 500,
        totalActualLabor: 800,
        totalParts: 100,
        totalNet: 900,
        totalAmount: 900,
      }),
    ).toEqual({ totalNet: 600, totalVat: 0, totalAmount: 600 });
  });

  // guards: BR-WO-007
  it('приймає Decimal-подібні значення з БД (рядки) так само, як числа', () => {
    expect(
      plannedWorkOrderTotals({
        totalLabor: '1000.00',
        totalActualLabor: '1100.00',
        totalParts: '200.00',
        totalNet: '1300.00',
        totalAmount: '1560.00',
      }),
    ).toEqual({ totalNet: 1200, totalVat: 240, totalAmount: 1440 });
  });

  // guards: BR-WO-007
  it('інваріант: totalNet + totalVat = totalAmount; план лишається базою свого режиму', () => {
    const cents = (min: number, max: number) => fc.integer({ min, max }).map(c => c / 100);
    const mode = fc.constantFrom<VatMode>('NONE', 'EXCLUSIVE', 'INCLUSIVE');
    const rate = fc.constantFrom(7, 14, 20);

    fc.assert(
      fc.property(
        cents(0, 5_000_000),
        cents(100, 5_000_000),
        cents(0, 5_000_000),
        mode,
        rate,
        (labor, actualLabor, parts, vatMode, vatRate) => {
          // Тотали наряду — від факту, як їх пише recalc.
          const actualBase = money(actualLabor + parts);
          const vat = calcVatOnBase(actualBase, vatMode === 'NONE' ? 0 : vatRate, vatMode);
          const wo = splitWorkOrderTotal(actualBase, vat, vatMode);
          const plannedBase = money(labor + parts);

          const res = plannedWorkOrderTotals({
            totalLabor: labor,
            totalActualLabor: actualLabor,
            totalParts: parts,
            ...wo,
          });

          expect(money(res.totalNet + res.totalVat)).toBe(res.totalAmount);
          expect(res.totalVat).toBeGreaterThanOrEqual(0);
          if (vatMode === 'EXCLUSIVE') expect(res.totalNet).toBe(plannedBase);
          else expect(res.totalAmount).toBe(plannedBase);
          if (vatMode === 'NONE') expect(res.totalVat).toBe(0);
        },
      ),
      { numRuns: 500 },
    );
  });
});
