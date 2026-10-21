// Bug #915: заголовок дня («Середа, 21 жовтня 2026 р.») і місяця календаря форматувались
// `Intl.DateTimeFormat('uk-UA')` незалежно від мови інтерфейсу — в en-локалі українською.
// Мутація: повернути фіксоване 'uk-UA' → падають en-кейси.

import { afterEach, describe, expect, it } from 'vitest';
import { setCurrentLocale } from '@/i18n/locale';
import { formatKyivDate, fmtKyivMonthYear } from '../calendar.utils';

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
