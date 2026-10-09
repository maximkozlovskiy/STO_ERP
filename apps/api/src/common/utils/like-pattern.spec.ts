/**
 * escapeLike — текст пошуку як буквальний рядок для Prisma `contains`.
 *
 * Mutation-verify: прибрати з класу символів `%`, `_` або `\\` → відповідний кейс падає.
 */
import { describe, it, expect } from 'vitest';
import { escapeLike, LIST_SEARCH_MAX_LENGTH, searchContains } from './like-pattern';

describe('escapeLike — символи підстановки LIKE у тексті пошуку', () => {
  it('звичайний текст (кирилиця, цифри, дефіс, пробіл) не змінюється', () => {
    expect(escapeLike('ПН-000123 оренда')).toBe('ПН-000123 оренда');
  });

  it('% екранується: «100%» шукає саме знак відсотка, а не «100» і будь-що далі', () => {
    expect(escapeLike('100%')).toBe('100\\%');
  });

  it('_ екранується: артикул «AB_12» не збігається з «ABX12»', () => {
    expect(escapeLike('AB_12')).toBe('AB\\_12');
  });

  it('зворотна коса подвоюється — інакше вона сама екранувала б наступний символ', () => {
    expect(escapeLike('a\\b')).toBe('a\\\\b');
    expect(escapeLike('\\%')).toBe('\\\\\\%');
  });

  it('кілька символів підряд екрануються всі', () => {
    expect(escapeLike('%_%')).toBe('\\%\\_\\%');
  });
});

describe('searchContains — текст пошуку списку → умова Prisma', () => {
  it('обрізає пробіли з країв, екранує підстановки, шукає без урахування регістру', () => {
    expect(searchContains('  5%_ ')).toEqual({ contains: '5\\%\\_', mode: 'insensitive' });
  });

  it('не задано, порожній рядок або самі пробіли → undefined (умову не додають)', () => {
    expect(searchContains(undefined)).toBeUndefined();
    expect(searchContains('')).toBeUndefined();
    expect(searchContains('   ')).toBeUndefined();
  });

  it('довший за LIST_SEARCH_MAX_LENGTH текст обрізається ДО екранування', () => {
    const long = '%'.repeat(LIST_SEARCH_MAX_LENGTH + 20);
    expect(LIST_SEARCH_MAX_LENGTH).toBe(100);
    expect(searchContains(long)?.contains).toBe('\\%'.repeat(LIST_SEARCH_MAX_LENGTH));
  });

  // code-review 2026-10-09: три списки беруть `q` з `@Query('q')` без DTO; повторений параметр
  // (`?q=a&q=b`) приходить масивом, і `.trim()` на ньому давав TypeError → 500.
  it.each([[['a', 'b']], [42], [{ q: 'x' }], [null]])(
    'searchContains: не-рядок %j — «пошуку немає», без винятку',
    value => {
      expect(searchContains(value as never)).toBeUndefined();
    },
  );
});
