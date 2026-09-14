import { describe, it, expect } from 'vitest';
import { convertToBase } from './currency';

describe('convertToBase (мультивалютна конвертація у базову)', () => {
  it('base = amount × rate / coefficient (coeff=1)', () => {
    expect(convertToBase(100, 41.5, 1)).toBe(4150);
    expect(convertToBase(50, 44, 1)).toBe(2200);
  });

  it('coefficient>1 (курс за N одиниць): base = amount × rate / coeff', () => {
    // rate=4150 за 100 одиниць → 1 одиниця = 41.5
    expect(convertToBase(100, 4150, 100)).toBe(4150);
  });

  it('базова валюта rate=1 → base=amount', () => {
    expect(convertToBase(1234.56, 1, 1)).toBe(1234.56);
  });

  it('roundMoney: 2 знаки, half-away-from-zero', () => {
    // 33.33 × 3.005 = 100.15665 → 100.16
    expect(convertToBase(33.33, 3.005, 1)).toBe(100.16);
  });

  it('safeCoeff гардить coefficient=0 → 1 (не ділення на 0)', () => {
    expect(convertToBase(100, 41.5, 0)).toBe(4150);
    expect(convertToBase(100, 41.5, NaN)).toBe(4150);
  });
});
