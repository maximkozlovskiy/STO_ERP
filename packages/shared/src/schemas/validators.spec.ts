import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  clearableCalendarDate,
  clearableString,
  isCalendarYmd,
  moneyString,
  normalizeDecimalInput,
  optionalCalendarDate,
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

// Review 2026-11-04: дати працівника стали clearableString — 'not-a-date' проходив схему, сервіс
// робив `new Date('not-a-date')`, і Prisma давала 500 замість 400. Мутація: прибрати refine у
// clearableCalendarDate → кейс «не дата» червоніє.
describe('clearableCalendarDate — дата, яку PATCH може очистити', () => {
  const schema = z.object({ d: clearableCalendarDate() }).partial();

  it.each([
    ['порожній рядок', { d: '' }, { d: null }],
    ['null', { d: null }, { d: null }],
    ['дата', { d: '2026-11-04' }, { d: '2026-11-04' }],
    ['ключа немає — не чіпати', {}, {}],
  ] as const)('%s', (_label, input, expected) => {
    expect(schema.parse(input)).toEqual(expected);
  });

  it('не дата → помилка валідації (400), а не 500 у Prisma', () => {
    expect(schema.safeParse({ d: 'not-a-date' }).success).toBe(false);
  });
});

// Bug #1039: перевірка через `Date.parse` пропускала все, що V8 вміє прочитати: 31.02 → 03.03,
// 'hello 5' → 2001, а рік 0000 / п'ять цифр доходив до Postgres → 500. Мутація: повернути
// `!Number.isNaN(Date.parse(v))` у calendarDate → кожен рядок нижче червоніє.
describe('календарна дата працівника — лише YYYY-MM-DD, що існує (Bug #1039)', () => {
  const bad = [
    '2026-02-31',
    'hello 5',
    '1',
    '0000-01-01',
    '99999-01-01',
    '+275760-09-13',
    '-000001-01-01',
    '2026-11-04T10:00:00.000Z',
  ];

  it.each(bad.map(v => [v]))('clearableCalendarDate: %s → помилка валідації', v => {
    expect(z.object({ d: clearableCalendarDate() }).safeParse({ d: v }).success).toBe(false);
  });

  it.each(bad.map(v => [v]))('optionalCalendarDate: %s → помилка валідації', v => {
    expect(z.object({ d: optionalCalendarDate() }).safeParse({ d: v }).success).toBe(false);
  });

  it.each([['2024-02-29'], ['0001-01-01'], ['9999-12-31']])('%s — справжня дата, проходить', v => {
    expect(isCalendarYmd(v)).toBe(true);
    expect(z.object({ d: optionalCalendarDate() }).parse({ d: v })).toEqual({ d: v });
  });

  it("optionalCalendarDate: '' і null → undefined (створення без дати)", () => {
    expect(z.object({ d: optionalCalendarDate() }).parse({ d: '' })).toEqual({ d: undefined });
    expect(z.object({ d: optionalCalendarDate() }).parse({ d: null })).toEqual({ d: undefined });
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
