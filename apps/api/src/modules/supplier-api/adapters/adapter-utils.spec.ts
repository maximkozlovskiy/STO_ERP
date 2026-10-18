import { describe, expect, it } from 'vitest';
import { keepValidOffers, parsePrice, parseQty, parseSupplierDate } from './adapter-utils';
import type { NormalizedOffer } from './supplier-adapter.interface';

describe('нормалізація відповідей постачальників (BR-SOFR-001)', () => {
  // guards: BR-SOFR-001
  it.each([
    [4, { qty: 4, lowerBound: false }],
    ['12', { qty: 12, lowerBound: false }],
    ['> 10', { qty: 10, lowerBound: true }],
    ['>10', { qty: 10, lowerBound: true }],
    ['≥10', { qty: 10, lowerBound: true }],
    ['5+', { qty: 5, lowerBound: true }],
    ['>', { qty: 1, lowerBound: true }],
    ['-', { qty: 0, lowerBound: false }],
    ['', { qty: 0, lowerBound: false }],
    ['2,5', { qty: 2.5, lowerBound: false }],
    [null, { qty: 0, lowerBound: false }],
  ])('кількість %j → %j', (raw, expected) => {
    expect(parseQty(raw)).toEqual(expected);
  });

  it('ціна: рядок із комою й пробілами; сміття → NaN', () => {
    expect(parsePrice('1 250,50')).toBe(1250.5);
    expect(parsePrice('325.50')).toBe(325.5);
    expect(Number.isNaN(parsePrice('n/a'))).toBe(true);
  });

  it('дата: «YYYY-MM-DD» — північ UTC, «YYYY-MM-DD HH:mm:ss» — як ISO; сміття → null', () => {
    expect(parseSupplierDate('2026-10-20')?.toISOString()).toBe('2026-10-20T00:00:00.000Z');
    expect(parseSupplierDate('2026-10-20 10:00:00')).toBeInstanceOf(Date);
    expect(parseSupplierDate('скоро')).toBeNull();
  });

  // guards: BR-SOFR-001
  it('пропозиція з qty ≤ 0 чи price ≤ 0 (або не число) не зберігається', () => {
    const base = { qty: 1, price: 10 } as NormalizedOffer;
    const kept = keepValidOffers([
      base,
      { ...base, qty: 0 },
      { ...base, price: 0 },
      { ...base, price: Number.NaN },
      { ...base, qty: -1 },
    ]);
    expect(kept).toEqual([base]);
  });
});
