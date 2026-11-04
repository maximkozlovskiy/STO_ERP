import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  clearableString,
  moneyString,
  normalizeDecimalInput,
  optionalMoneyNumber,
  patchBodyWithClears,
} from './validators';

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

// TECH-DEBT (а) 2026-11-01: очищене у формі поле лишалося в БД — '' і null у PATCH означали «не змінювати».
describe('clearableString — PATCH-поле, яке можна очистити', () => {
  const schema = z.object({ notes: clearableString() }).partial();

  it.each([
    ['порожній рядок', { notes: '' }, { notes: null }],
    ['null', { notes: null }, { notes: null }],
    ['значення', { notes: 'x' }, { notes: 'x' }],
    ['ключа немає — не чіпати', {}, {}],
  ] as const)('%s', (_label, input, expected) => {
    expect(schema.parse(input)).toEqual(expected);
  });
});

describe('patchBodyWithClears — null лише для поля, що мало значення', () => {
  const fields = ['notes', 'color'] as const;

  it('мало значення й стало порожнім (undefined чи "") → null', () => {
    expect(patchBodyWithClears({ name: 'A' }, { notes: 'старе', color: 'red' }, fields)).toEqual({
      name: 'A',
      notes: null,
      color: null,
    });
    expect(patchBodyWithClears({ notes: '' }, { notes: 'старе' }, fields)).toEqual({ notes: null });
  });

  it('у оригіналі поля не було (рядок списку) чи воно порожнє → ключа немає', () => {
    expect(patchBodyWithClears({ name: 'A' }, { color: '' }, fields)).toEqual({ name: 'A' });
    expect(patchBodyWithClears({ name: 'A' }, null, fields)).toEqual({ name: 'A' });
  });

  it('нове значення лишається як є', () => {
    expect(patchBodyWithClears({ notes: 'нове' }, { notes: 'старе' }, fields)).toEqual({
      notes: 'нове',
    });
  });
});
