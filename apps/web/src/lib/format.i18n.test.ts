import { describe, it, expect, afterEach } from 'vitest';
import { setCurrentLocale } from '@/i18n/locale';
import { fmtMoney, fmtInt, fmtPercent, kyivToday, kyivDateTimeToISO } from './format';

// format.ts display-форматери locale-aware; ISO/machine-хелпери — locale-INDEPENDENT.
describe('format.ts — locale-aware форматування', () => {
  afterEach(() => setCurrentLocale('uk'));

  it('uk: fmtMoney(1234.5) → «1 234,50» (пробіл + кома)', () => {
    setCurrentLocale('uk');
    const s = fmtMoney(1234.5);
    // uk-UA: тонкий/нерозривний пробіл-роздільник тисяч + кома-десятковий
    expect(s.replace(/\s/g, ' ')).toBe('1 234,50');
  });

  it('en: fmtMoney(1234.5) → «1,234.50» (кома + крапка)', () => {
    setCurrentLocale('en');
    expect(fmtMoney(1234.5)).toBe('1,234.50');
  });

  it('uk vs en: fmtInt(123456) різні роздільники тисяч', () => {
    setCurrentLocale('uk');
    const uk = fmtInt(123456).replace(/\s/g, ' ');
    setCurrentLocale('en');
    const en = fmtInt(123456);
    expect(uk).toBe('123 456');
    expect(en).toBe('123,456');
  });

  it('ISO/machine-хелпери НЕ залежать від локалі (kyivToday, kyivDateTimeToISO)', () => {
    setCurrentLocale('uk');
    const ukToday = kyivToday();
    const ukIso = kyivDateTimeToISO('2026-06-05', '09:00');
    setCurrentLocale('en');
    expect(kyivToday()).toBe(ukToday); // YYYY-MM-DD незмінний
    expect(kyivDateTimeToISO('2026-06-05', '09:00')).toBe(ukIso); // UTC ISO незмінний
    expect(ukIso).toBe('2026-06-05T06:00:00.000Z'); // літо EEST +03
  });

  // Огляд звітів 2026-10-29: «59.3%» з крапкою в українському інтерфейсі.
  it('fmtPercent: uk — десяткова кома, en — крапка; до одного знака; відсоток, не частка', () => {
    setCurrentLocale('uk');
    expect(fmtPercent(59.25).replace(/\s/g, ' ')).toBe('59,3%');
    expect(fmtPercent(12).replace(/\s/g, ' ')).toBe('12%');
    expect(fmtPercent(140).replace(/\s/g, ' ')).toBe('140%');
    setCurrentLocale('en');
    expect(fmtPercent(59.25)).toBe('59.3%');
    expect(fmtPercent(null)).toBe('—');
    expect(fmtPercent(Number.NaN)).toBe('—');
  });

  it('null → «—» в обох локалях', () => {
    setCurrentLocale('en');
    expect(fmtMoney(null)).toBe('—');
    expect(fmtInt(undefined)).toBe('—');
  });
});
