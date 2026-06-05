import { describe, it, expect } from 'vitest';
import { safeCoeff } from './math';

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
