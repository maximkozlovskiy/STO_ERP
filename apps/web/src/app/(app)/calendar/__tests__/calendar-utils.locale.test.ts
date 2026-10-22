// Bug #915: заголовок дня («Середа, 21 жовтня 2026 р.») і місяця календаря форматувались
// `Intl.DateTimeFormat('uk-UA')` незалежно від мови інтерфейсу — в en-локалі українською.
// Мутація: повернути фіксоване 'uk-UA' → падають en-кейси.

import { afterEach, describe, expect, it } from 'vitest';
import { setCurrentLocale } from '@/i18n/locale';
import { formatKyivDate, fmtKyivMonthYear, fmtKyivDate, fmtTime } from '../calendar.utils';

afterEach(() => setCurrentLocale('uk'));

describe('заголовки календаря йдуть за мовою інтерфейсу (Bug #915)', () => {
  it('uk: день і місяць українською', () => {
    setCurrentLocale('uk');
    expect(formatKyivDate('2026-10-21')).toMatch(/середа/i);
    expect(fmtKyivMonthYear('2026-10-21')).toMatch(/жовт/i);
  });

  it('en: день і місяць англійською, без кирилиці', () => {
    setCurrentLocale('en');
    const day = formatKyivDate('2026-10-21');
    const month = fmtKyivMonthYear('2026-10-21');
    expect(day).toMatch(/Wednesday/);
    expect(day).toMatch(/October/);
    expect(month).toMatch(/October 2026/);
    expect(`${day} ${month}`).not.toMatch(/[А-ЯІЇЄҐа-яіїєґ]/);
  });
});

// TECH-DEBT §15.3: час і дата в списках календаря були `Intl.DateTimeFormat('uk-UA')` — дата в en
// не йшла за мовою, як `fmtDate` решти застосунку. Час — 24-годинний в обох мовах.
describe('час і дата записів — за мовою інтерфейсу', () => {
  // 2026-10-21 00:05 за Києвом (UTC+3).
  const MIDNIGHT = '2026-10-20T21:05:00Z';

  it('uk: DD.MM.YYYY і 24-годинний час', () => {
    setCurrentLocale('uk');
    expect(fmtKyivDate(MIDNIGHT)).toBe('21.10.2026');
    expect(fmtTime(MIDNIGHT)).toBe('00:05');
    expect(fmtTime('2026-10-21T10:29:00Z')).toBe('13:29');
  });

  it('en: дата за мовою, час 24-годинний', () => {
    setCurrentLocale('en');
    expect(fmtKyivDate(MIDNIGHT)).toBe('10/21/2026');
    expect(fmtTime(MIDNIGHT)).toBe('00:05');
    expect(fmtTime('2026-10-21T10:29:00Z')).toBe('13:29');
  });
});
