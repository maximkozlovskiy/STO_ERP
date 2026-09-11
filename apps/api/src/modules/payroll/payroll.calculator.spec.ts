import { describe, it, expect } from 'vitest';
import { computeAccrued, parseRateScheme } from './payroll.calculator';

describe('parseRateScheme', () => {
  it('percent_normo валідний', () => {
    expect(parseRateScheme({ type: 'percent_normo', params: { percent: 40 } })).toEqual({
      type: 'percent_normo',
      params: { percent: 40 },
    });
  });

  it('per_normo_hour валідний', () => {
    expect(parseRateScheme({ type: 'per_normo_hour', params: { ratePerHour: 150 } })).toEqual({
      type: 'per_normo_hour',
      params: { ratePerHour: 150 },
    });
  });

  it('fixed_plus_bonus валідний', () => {
    expect(
      parseRateScheme({
        type: 'fixed_plus_bonus',
        params: { fixedMonthly: 8000, bonusPercent: 10 },
      }),
    ).toEqual({ type: 'fixed_plus_bonus', params: { fixedMonthly: 8000, bonusPercent: 10 } });
  });

  it('сміття/невідомий тип/нечислові params → null', () => {
    expect(parseRateScheme(null)).toBeNull();
    expect(parseRateScheme({})).toBeNull();
    expect(parseRateScheme({ type: 'unknown', params: {} })).toBeNull();
    expect(parseRateScheme({ type: 'percent_normo', params: { percent: 'x' } })).toBeNull();
    expect(parseRateScheme({ type: 'per_normo_hour', params: {} })).toBeNull();
  });
});

describe('computeAccrued', () => {
  const work = { baseAmount: 10000, normoHours: 20 };

  it('percent_normo: % від суми робіт', () => {
    const s = parseRateScheme({ type: 'percent_normo', params: { percent: 40 } });
    expect(computeAccrued(s, work)).toBe(4000); // 40% від 10000
  });

  it('per_normo_hour: ставка × нормо-години', () => {
    const s = parseRateScheme({ type: 'per_normo_hour', params: { ratePerHour: 150 } });
    expect(computeAccrued(s, work)).toBe(3000); // 150 × 20
  });

  it('fixed_plus_bonus: фікс + % від суми', () => {
    const s = parseRateScheme({
      type: 'fixed_plus_bonus',
      params: { fixedMonthly: 8000, bonusPercent: 10 },
    });
    expect(computeAccrued(s, work)).toBe(9000); // 8000 + 10% від 10000
  });

  it('округлення до копійки (half-away-from-zero)', () => {
    const s = parseRateScheme({ type: 'percent_normo', params: { percent: 33.33 } });
    // 33.33% від 100.10 = 33.363... → 33.36
    expect(computeAccrued(s, { baseAmount: 100.1, normoHours: 0 })).toBe(33.36);
  });

  it('невалідна схема → 0', () => {
    expect(computeAccrued(null, work)).toBe(0);
  });

  it('відʼємний/нульовий виробіток → 0 (clamp)', () => {
    const s = parseRateScheme({ type: 'percent_normo', params: { percent: 40 } });
    expect(computeAccrued(s, { baseAmount: 0, normoHours: 0 })).toBe(0);
    expect(computeAccrued(s, { baseAmount: -500, normoHours: 0 })).toBe(0);
  });

  it('fixed_plus_bonus з нульовим виробітком → лише фікс', () => {
    const s = parseRateScheme({
      type: 'fixed_plus_bonus',
      params: { fixedMonthly: 8000, bonusPercent: 10 },
    });
    expect(computeAccrued(s, { baseAmount: 0, normoHours: 0 })).toBe(8000);
  });
});
