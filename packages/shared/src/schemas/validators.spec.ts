import { describe, it, expect } from 'vitest';
import { moneyString, normalizeDecimalInput, optionalMoneyNumber } from './validators';

// «1 000,50» у полі суми (TECH-DEBT §10 п.22): раніше пробіл між розрядами давав NaN. Intl для
// uk-UA ставить вузький нерозривний пробіл U+202F, а дехто — NBSP U+00A0. Мутація: прибрати
// очищення пробілів у normalizeDecimalInput → кейси з розрядами червоніють.
describe('normalizeDecimalInput', () => {
  it.each([
    ['1 000,50', '1000.50'],
    ['1 000,50', '1000.50'],
    ['1 000,50', '1000.50'],
    ['1,5', '1.5'],
    [' 12 ', '12'],
    ['1000.25', '1000.25'],
  ])('«%s» → %s', (input, expected) => {
    expect(normalizeDecimalInput(input)).toBe(expected);
  });
});

describe('moneyString / optionalMoneyNumber', () => {
  it('сума з пробілами між розрядами і комою — число', () => {
    expect(moneyString().parse('1 000,50')).toBe(1000.5);
    expect(moneyString().parse('1 234 567,89')).toBe(1234567.89);
    expect(optionalMoneyNumber().parse('2 500,5')).toBe(2500.5);
  });

  it('сміття — не число; порожнє опційне — undefined', () => {
    expect(moneyString().safeParse('12abc').success).toBe(false);
    expect(optionalMoneyNumber().parse('')).toBeUndefined();
  });
});
