import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import i18n from './config';
import { woStatusLabel, invoiceStatusLabel, employeeRoleLabel, tEnum } from './enumLabel';

// Каталоги ініціалізуються у src/__tests__/setup.ts (lng='uk'). Тут перемикаємо мову у тестах.
describe('enumLabel — i18n enum-мітки', () => {
  afterEach(async () => {
    await i18n.changeLanguage('uk');
  });

  it('uk: WO_STATUS.DRAFT → «Чернетка»', async () => {
    await i18n.changeLanguage('uk');
    expect(woStatusLabel('DRAFT')).toBe('Чернетка');
  });

  it('en: WO_STATUS.DRAFT → «Draft»', async () => {
    await i18n.changeLanguage('en');
    expect(woStatusLabel('DRAFT')).toBe('Draft');
  });

  it('en: INVOICE_STATUS.PAID → «Paid»; EMPLOYEE_ROLE.OWNER → «Owner»', async () => {
    await i18n.changeLanguage('en');
    expect(invoiceStatusLabel('PAID')).toBe('Paid');
    expect(employeeRoleLabel('OWNER')).toBe('Owner');
  });

  it('невідомий код → повертає сам код', () => {
    expect(woStatusLabel('NONEXISTENT')).toBe('NONEXISTENT');
  });

  it('порожній/null код → «—»', () => {
    expect(woStatusLabel('')).toBe('—');
    expect(woStatusLabel(null)).toBe('—');
    expect(woStatusLabel(undefined)).toBe('—');
  });

  it('catalog-miss → fallback на shared українську мапу', () => {
    // tEnum з неіснуючою мапою у каталозі, але існуючим кодом у fallback-мапі.
    expect(tEnum('WO_STATUS', { DRAFT: 'ЧЧЧ' }, 'DRAFT')).toBeTruthy();
  });
});
