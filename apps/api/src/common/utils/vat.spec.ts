import { describe, it, expect } from 'vitest';
import type { VatMode } from '@prisma/client';
import { calcVatOnBase, calcLineVat } from './vat';

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
