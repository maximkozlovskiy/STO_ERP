import { describe, it, expect } from 'vitest';
import {
  employeeFormSchema,
  employeeCreateSchema,
  employeeUpdateSchema,
  buildRateScheme,
} from '@sto/shared';

// Спільні zod-схеми співробітника (packages/shared) — тестуємо в api (є vitest + споживає shared).
describe('employeeFormSchema (плоска форма)', () => {
  const base = {
    firstName: 'Іван',
    lastName: 'Коваль',
    role: 'MECHANIC',
    rateType: 'percent_normo',
    percent: '40',
    ratePerHour: '0',
    fixedMonthly: '0',
    bonusPercent: '10',
  };

  it('приймає валідну форму (percent_normo)', () => {
    const r = employeeFormSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.percent).toBe(40); // коерсія рядок→число
  });

  it("відхиляє порожнє ім'я/прізвище укр. повідомленням", () => {
    const r = employeeFormSchema.safeParse({ ...base, firstName: '  ' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some(i => i.message === "Вкажіть ім'я")).toBe(true);
  });

  it('відхиляє невалідну посаду', () => {
    const r = employeeFormSchema.safeParse({ ...base, role: 'GOD' });
    expect(r.success).toBe(false);
  });

  it('percent поза 1..100 → помилка на полі percent', () => {
    const r = employeeFormSchema.safeParse({ ...base, percent: '150' });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find(i => i.path[0] === 'percent');
      expect(issue?.message).toBe('Відсоток має бути від 1 до 100');
    }
  });

  it('fixed_plus_bonus: bonus поза 0..100 → помилка bonusPercent', () => {
    const r = employeeFormSchema.safeParse({
      ...base,
      rateType: 'fixed_plus_bonus',
      fixedMonthly: '10000',
      bonusPercent: '120',
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some(i => i.path[0] === 'bonusPercent')).toBe(true);
  });

  it('grantAccess без пароля → помилки loginEmail+password', () => {
    const r = employeeFormSchema.safeParse({
      ...base,
      grantAccess: true,
      loginEmail: '',
      password: '',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some(i => i.path[0] === 'loginEmail')).toBe(true);
      expect(r.error.issues.some(i => i.path[0] === 'password')).toBe(true);
    }
  });

  it('grantAccess з коротким паролем → «не менше 6 символів»', () => {
    const r = employeeFormSchema.safeParse({
      ...base,
      grantAccess: true,
      loginEmail: 'a@b.com',
      password: '123',
    });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.some(i => i.message === 'Пароль має бути не менше 6 символів')).toBe(
        true,
      );
  });
});

describe('buildRateScheme', () => {
  it('percent_normo → nested', () => {
    expect(
      buildRateScheme({
        rateType: 'percent_normo',
        percent: 40,
        ratePerHour: 0,
        fixedMonthly: 0,
        bonusPercent: 0,
      }),
    ).toEqual({
      type: 'percent_normo',
      params: { percent: 40 },
    });
  });
  it('fixed_plus_bonus → nested', () => {
    expect(
      buildRateScheme({
        rateType: 'fixed_plus_bonus',
        percent: 0,
        ratePerHour: 0,
        fixedMonthly: 12000,
        bonusPercent: 15,
      }),
    ).toEqual({
      type: 'fixed_plus_bonus',
      params: { fixedMonthly: 12000, bonusPercent: 15 },
    });
  });
});

describe('employeeCreate/UpdateSchema (бек-payload)', () => {
  const payload = {
    firstName: 'Іван',
    lastName: 'Коваль',
    role: 'MECHANIC',
    rateScheme: { type: 'percent_normo', params: { percent: 40 } },
  };

  it('create приймає валідний payload', () => {
    expect(employeeCreateSchema.safeParse(payload).success).toBe(true);
  });

  it('create відхиляє битий rateScheme', () => {
    const r = employeeCreateSchema.safeParse({
      ...payload,
      rateScheme: { type: 'percent_normo', params: { percent: 200 } },
    });
    expect(r.success).toBe(false);
  });

  it('create з коротким паролем → помилка', () => {
    const r = employeeCreateSchema.safeParse({
      ...payload,
      loginEmail: 'a@b.com',
      password: '123',
    });
    expect(r.success).toBe(false);
  });

  it('update — усі поля опційні (порожній обʼєкт валідний)', () => {
    expect(employeeUpdateSchema.safeParse({}).success).toBe(true);
  });
});
