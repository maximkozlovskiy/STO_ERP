import { describe, it, expect } from 'vitest';
import { safeCoeff, roundMoney } from './math';

describe('safeCoeff', () => {
  it('повертає value для позитивного числа', () => {
    expect(safeCoeff(2)).toBe(2);
    expect(safeCoeff(1.5)).toBe(1.5);
    expect(safeCoeff(0.000001)).toBe(0.000001);
  });

  it('повертає 1 для null', () => {
    expect(safeCoeff(null)).toBe(1);
  });

  it('повертає 1 для undefined', () => {
    expect(safeCoeff(undefined)).toBe(1);
  });

  it('повертає 1 для 0', () => {
    expect(safeCoeff(0)).toBe(1);
  });

  it("повертає 1 для від'ємного числа", () => {
    expect(safeCoeff(-1)).toBe(1);
    expect(safeCoeff(-0.5)).toBe(1);
  });

  it('повертає 1 для NaN', () => {
    expect(safeCoeff(NaN)).toBe(1);
  });

  it('повертає 1 для Infinity', () => {
    expect(safeCoeff(Infinity)).toBe(1);
  });

  it('повертає 1 для -Infinity', () => {
    expect(safeCoeff(-Infinity)).toBe(1);
  });

  it('безпечний дільник: 10 / safeCoeff(0) = 10 (не ділення на 0)', () => {
    const qty = 10;
    const result = qty / safeCoeff(0);
    expect(result).toBe(10);
    expect(Number.isFinite(result)).toBe(true);
  });

  it('коректно обчислює qty / coeff для базового перетворення одиниць', () => {
    expect(10 / safeCoeff(2)).toBe(5);
    expect(10 / safeCoeff(0.5)).toBe(20);
  });
});

describe('roundMoney (FIN-H1/WO-H2)', () => {
  it('округлює до 2 знаків', () => {
    expect(roundMoney(60.059999999999995)).toBe(60.06);
    expect(roundMoney(300.3 * 0.2)).toBe(60.06);
    expect(roundMoney(123.333333)).toBe(123.33);
    expect(roundMoney(123.335)).toBe(123.34); // half-away-from-zero
  });

  it('нейтралізує float-представлення (0.1+0.2)', () => {
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(1.005)).toBe(1.01); // +1e-9 епсилон рятує від 1.00
  });

  it("від'ємні — half-away-from-zero симетрично", () => {
    expect(roundMoney(-60.055)).toBe(-60.06);
    expect(roundMoney(-0.005)).toBe(-0.01);
  });

  it('ціле лишається цілим; 0 та нескінченності → 0/безпечно', () => {
    expect(roundMoney(100)).toBe(100);
    expect(roundMoney(0)).toBe(0);
    expect(roundMoney(NaN)).toBe(0);
    expect(roundMoney(Infinity)).toBe(0);
  });

  it('Σ округлених рядків стабільна (інваріант Σ==total)', () => {
    // 3 рядки по 33.333... округлюються до 33.33; сума 99.99, не 100.
    const line = roundMoney(100 / 3);
    expect(line).toBe(33.33);
    expect(roundMoney(line * 3)).toBe(99.99);
  });
});
