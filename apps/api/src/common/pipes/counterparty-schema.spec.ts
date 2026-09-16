import { describe, it, expect } from 'vitest';
import { counterpartyFormSchema, counterpartyUpdateSchema, hasCounterpartyName } from '@sto/shared';

describe('counterpartyFormSchema (спільна, web ↔ api)', () => {
  it('CLIENT з імʼям — валідний', () => {
    expect(counterpartyFormSchema.safeParse({ type: 'CLIENT', firstName: 'Іван' }).success).toBe(
      true,
    );
  });

  it('CLIENT з назвою компанії — валідний', () => {
    expect(counterpartyFormSchema.safeParse({ type: 'CLIENT', companyName: 'ТОВ' }).success).toBe(
      true,
    );
  });

  it('CLIENT без імені й компанії → помилка на companyName', () => {
    const r = counterpartyFormSchema.safeParse({ type: 'CLIENT' });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find(i => i.path[0] === 'companyName');
      expect(issue?.message).toContain("ім'я/прізвище");
    }
  });

  it('SUPPLIER без companyName → помилка (навіть з firstName)', () => {
    const r = counterpartyFormSchema.safeParse({ type: 'SUPPLIER', firstName: 'Іван' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe('Вкажіть назву компанії постачальника');
  });

  it('SUPPLIER з companyName — валідний', () => {
    expect(
      counterpartyFormSchema.safeParse({ type: 'SUPPLIER', companyName: 'ТОВ Пост' }).success,
    ).toBe(true);
  });

  it('невалідний email → помилка', () => {
    const r = counterpartyFormSchema.safeParse({ type: 'CLIENT', firstName: 'Іван', email: 'bad' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some(i => i.path[0] === 'email')).toBe(true);
  });

  it("порожній email ('') → undefined, не помилка", () => {
    expect(
      counterpartyFormSchema.safeParse({ type: 'CLIENT', firstName: 'Іван', email: '' }).success,
    ).toBe(true);
  });

  it('невалідний legalForm → помилка; порожній → ok', () => {
    expect(
      counterpartyFormSchema.safeParse({ type: 'CLIENT', firstName: 'І', legalForm: 'WAT' })
        .success,
    ).toBe(false);
    expect(
      counterpartyFormSchema.safeParse({ type: 'CLIENT', firstName: 'І', legalForm: '' }).success,
    ).toBe(true);
  });

  it('update — усі поля опційні, порожній обʼєкт ok (name-by-type перевіряє сервіс на merged)', () => {
    expect(counterpartyUpdateSchema.safeParse({}).success).toBe(true);
  });
});

describe('hasCounterpartyName', () => {
  it('SUPPLIER — лише companyName', () => {
    expect(hasCounterpartyName({ type: 'SUPPLIER', companyName: 'X' })).toBe(true);
    expect(hasCounterpartyName({ type: 'SUPPLIER', firstName: 'X' })).toBe(false);
  });
  it('CLIENT — компанія або імʼя', () => {
    expect(hasCounterpartyName({ type: 'CLIENT', firstName: 'X' })).toBe(true);
    expect(hasCounterpartyName({ type: 'CLIENT' })).toBe(false);
  });
});
