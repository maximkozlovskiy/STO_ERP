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

  // guards: BR-PAYR-007
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

  // guards: BR-PAYR-004
  it('percent_normo: % від суми робіт', () => {
    const s = parseRateScheme({ type: 'percent_normo', params: { percent: 40 } });
    expect(computeAccrued(s, work)).toBe(4000); // 40% від 10000
  });

  // guards: BR-PAYR-005
  it('per_normo_hour: ставка × нормо-години', () => {
    const s = parseRateScheme({ type: 'per_normo_hour', params: { ratePerHour: 150 } });
    expect(computeAccrued(s, work)).toBe(3000); // 150 × 20
  });

  // guards: BR-PAYR-006
  it('fixed_plus_bonus: фікс + % від суми', () => {
    const s = parseRateScheme({
      type: 'fixed_plus_bonus',
      params: { fixedMonthly: 8000, bonusPercent: 10 },
    });
    expect(computeAccrued(s, work)).toBe(9000); // 8000 + 10% від 10000
  });

  // guards: BR-PAYR-008
  it('округлення до копійки (half-away-from-zero)', () => {
    const s = parseRateScheme({ type: 'percent_normo', params: { percent: 33.33 } });
    // 33.33% від 100.10 = 33.363... → 33.36
    expect(computeAccrued(s, { baseAmount: 100.1, normoHours: 0 })).toBe(33.36);
  });

  // guards: BR-PAYR-007
  it('невалідна схема → 0', () => {
    expect(computeAccrued(null, work)).toBe(0);
  });

  // guards: BR-PAYR-008
  it('відʼємний/нульовий виробіток → 0 (clamp)', () => {
    const s = parseRateScheme({ type: 'percent_normo', params: { percent: 40 } });
    expect(computeAccrued(s, { baseAmount: 0, normoHours: 0 })).toBe(0);
    expect(computeAccrued(s, { baseAmount: -500, normoHours: 0 })).toBe(0);
  });

  // guards: BR-PAYR-006
  it('fixed_plus_bonus з нульовим виробітком → лише фікс', () => {
    const s = parseRateScheme({
      type: 'fixed_plus_bonus',
      params: { fixedMonthly: 8000, bonusPercent: 10 },
    });
    expect(computeAccrued(s, { baseAmount: 0, normoHours: 0 })).toBe(8000);
  });

  // guards: BR-PAYR-008
  it('рівно пів копійки округлюється від нуля: 0.5 год × 0.25 грн = 0.125 → 0.13', () => {
    const s = parseRateScheme({ type: 'per_normo_hour', params: { ratePerHour: 0.25 } });
    expect(computeAccrued(s, { baseAmount: 0, normoHours: 0.5 })).toBe(0.13);
  });

  // guards: BR-PAYR-008
  it('fixed_plus_bonus: сума фіксу й бонусу округлюється до копійки один раз', () => {
    const s = parseRateScheme({
      type: 'fixed_plus_bonus',
      params: { fixedMonthly: 8000, bonusPercent: 10 },
    });
    // 8000 + 10% від 12345.67 = 9234.567 → 9234.57
    expect(computeAccrued(s, { baseAmount: 12345.67, normoHours: 0 })).toBe(9234.57);
  });

  // guards: BR-PAYR-008
  it('відʼємні нормо-години рахуються як 0 (per_normo_hour не дає мінуса)', () => {
    const s = parseRateScheme({ type: 'per_normo_hour', params: { ratePerHour: 150 } });
    expect(computeAccrued(s, { baseAmount: 0, normoHours: -4 })).toBe(0);
  });

  // guards: BR-PAYR-006, BR-PAYR-008
  it('fixed_plus_bonus: відʼємна база не зменшує фіксовану частину', () => {
    const s = parseRateScheme({
      type: 'fixed_plus_bonus',
      params: { fixedMonthly: 8000, bonusPercent: 10 },
    });
    expect(computeAccrued(s, { baseAmount: -5000, normoHours: 0 })).toBe(8000);
  });

  // guards: BR-PAYR-005
  it('per_normo_hour не залежить від суми робіт, percent_normo — від нормо-годин', () => {
    const perHour = parseRateScheme({ type: 'per_normo_hour', params: { ratePerHour: 150 } });
    expect(computeAccrued(perHour, { baseAmount: 999999, normoHours: 2 })).toBe(300);
    const percent = parseRateScheme({ type: 'percent_normo', params: { percent: 40 } });
    expect(computeAccrued(percent, { baseAmount: 1000, normoHours: 999 })).toBe(400);
  });
});
