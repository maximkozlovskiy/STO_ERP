import { describe, it, expect } from 'vitest';
import { normalizeArticle } from './normalize-article';

describe('normalizeArticle', () => {
  it('прибирає дефіси й піднімає регістр', () => {
    expect(normalizeArticle('04E-129-620')).toBe('04E129620');
  });

  it('пробіли не впливають на результат — однаковий ключ', () => {
    expect(normalizeArticle('030101')).toBe(normalizeArticle('03 01 01'));
    expect(normalizeArticle('03 01 01')).toBe('030101');
  });

  it('змішані роздільники (крапка/слеш/пробіл) → однаковий ключ', () => {
    expect(normalizeArticle('04e.129/620')).toBe('04E129620');
  });

  it('lowercase латиниця піднімається у upper', () => {
    expect(normalizeArticle('abc123')).toBe('ABC123');
  });

  it('null → порожній рядок', () => {
    expect(normalizeArticle(null)).toBe('');
  });

  it('undefined → порожній рядок', () => {
    expect(normalizeArticle(undefined)).toBe('');
  });

  it('порожній рядок → порожній рядок', () => {
    expect(normalizeArticle('')).toBe('');
  });

  it('кирилиця прибирається ([^A-Z0-9])', () => {
    expect(normalizeArticle('АБВ123')).toBe('123');
    expect(normalizeArticle('масло')).toBe('');
  });

  it('лише роздільники → порожній рядок', () => {
    expect(normalizeArticle('---   ...')).toBe('');
  });
});
