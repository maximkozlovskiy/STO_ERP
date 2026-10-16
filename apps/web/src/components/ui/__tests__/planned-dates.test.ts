import { describe, it, expect } from 'vitest';
import {
  calcEndFromHours,
  calcPlannedHours,
  DEFAULT_WORK_HOURS_WINDOW,
} from '../work-order/planned-dates';

// BR-WO-019: автокінець і планові нормогодини наряду — у робочих годинах філії, а не в жорстких
// 08–20. Ніч і години поза вікном не рахуються — так само сервер ділить запис календаря наряду
// на дні (BR-WO-020).

const W818 = { startHour: 8, endHour: 18 };

describe('calcEndFromHours — автокінець за нормогодинами', () => {
  // guards: BR-WO-019
  it('вміщається в день → той самий день', () => {
    expect(calcEndFromHours('2026-05-22T10:00', 3, W818)).toBe('2026-05-22T13:00');
  });

  // guards: BR-WO-019
  it('рівно до закриття → 18:00 того ж дня', () => {
    expect(calcEndFromHours('2026-05-22T15:00', 3, W818)).toBe('2026-05-22T18:00');
  });

  // guards: BR-WO-019
  it('переповнення → наступного дня від відкриття філії (08:00), а не від 08:00 «за замовчуванням»', () => {
    expect(calcEndFromHours('2026-05-22T16:00', 3, W818)).toBe('2026-05-23T09:00');
    expect(calcEndFromHours('2026-05-22T16:00', 3, { startHour: 10, endHour: 19 })).toBe(
      '2026-05-22T19:00',
    );
    expect(calcEndFromHours('2026-05-22T16:00', 4, { startHour: 10, endHour: 19 })).toBe(
      '2026-05-23T11:00',
    );
  });

  // guards: BR-WO-019
  it('кілька днів: 25 год від 16:00 (вікно 10 год) → третій день', () => {
    expect(calcEndFromHours('2026-05-22T16:00', 25, W818)).toBe('2026-05-25T11:00');
  });

  it('початок до відкриття зсувається на відкриття; після закриття — на завтра', () => {
    expect(calcEndFromHours('2026-05-22T06:00', 2, W818)).toBe('2026-05-22T10:00');
    expect(calcEndFromHours('2026-05-22T19:00', 2, W818)).toBe('2026-05-23T10:00');
  });

  it('кінець місяця й року', () => {
    expect(calcEndFromHours('2026-12-31T17:00', 2, W818)).toBe('2027-01-01T09:00');
  });

  it('невалідний ввід → порожньо', () => {
    expect(calcEndFromHours('', 2, W818)).toBe('');
    expect(calcEndFromHours('2026-05-22T10:00', 0, W818)).toBe('');
    expect(calcEndFromHours('2026-05-22T10:00', Number.NaN, W818)).toBe('');
  });

  it('типові години — як на сервері, 09–18', () => {
    expect(DEFAULT_WORK_HOURS_WINDOW).toEqual({ startHour: 9, endHour: 18 });
  });
});

describe('calcPlannedHours — нормогодини між плановими датами', () => {
  // guards: BR-WO-019
  it('в межах дня — різниця', () => {
    expect(calcPlannedHours('2026-05-22T10:00', '2026-05-22T12:30', W818)).toBe('2.5');
  });

  // guards: BR-WO-019
  it('через ніч — лише робочий час: 16:00 → завтра 11:00 = 2 + 3', () => {
    expect(calcPlannedHours('2026-05-22T16:00', '2026-05-23T11:00', W818)).toBe('5');
  });

  it('узгоджено з автокінцем: кінець за N год дає назад N год', () => {
    const end = calcEndFromHours('2026-05-22T14:15', 13.5, W818);
    expect(calcPlannedHours('2026-05-22T14:15', end, W818)).toBe('13.5');
  });

  it('завершення не пізніше за початок або бракує дати → порожньо', () => {
    expect(calcPlannedHours('2026-05-22T12:00', '2026-05-22T12:00', W818)).toBe('');
    expect(calcPlannedHours('2026-05-22T12:00', '2026-05-22T11:00', W818)).toBe('');
    expect(calcPlannedHours(undefined, '2026-05-22T11:00', W818)).toBe('');
  });
});
