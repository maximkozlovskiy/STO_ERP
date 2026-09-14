import { roundMoney, safeCoeff } from './math';

/**
 * Конвертація суми у базову валюту (UAH) по курсу НБУ.
 *
 * Семантика ExchangeRate (виведено з nbu-fetch.service): `rate` = скільки БАЗОВИХ (UAH) за
 * (1 × coefficient) одиниць валюти. Тож: `base = amount × rate / coefficient`.
 * coefficient наразі завжди 1 (NBU exchange_site віддає курс за 1 одиницю), але формула тримає
 * запас для валют, що котируються за 100 одиниць. safeCoeff гардить 0/NaN/negative → 1.
 *
 * Для БАЗОВОЇ валюти передавати rate=1, coefficient=1 → base=amount (без втрат точності).
 */
export function convertToBase(amount: number, rate: number, coefficient: number): number {
  return roundMoney((amount * rate) / safeCoeff(coefficient));
}
