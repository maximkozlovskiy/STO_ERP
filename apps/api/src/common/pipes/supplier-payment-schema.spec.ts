import { describe, it, expect } from 'vitest';
import { supplierPaymentFormSchema, supplierPaymentUpdateSchema } from '@sto/shared';

const SUP = '11111111-1111-1111-1111-111111111111';
const ACC = '22222222-2222-2222-2222-222222222222';

const base = { supplierId: SUP, method: 'cash', amount: '100' };

describe('supplierPaymentFormSchema (спільна, web ↔ api)', () => {
  it('CASH_REGISTER з касою — валідний; кома в сумі коерситься', () => {
    const r = supplierPaymentFormSchema.safeParse({
      ...base,
      sourceType: 'CASH_REGISTER',
      cashRegisterId: ACC,
      amount: '1500,50',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.amount).toBe(1500.5); // UA-кома
  });

  it('CASH_REGISTER без каси → помилка на cashRegisterId', () => {
    const r = supplierPaymentFormSchema.safeParse({ ...base, sourceType: 'CASH_REGISTER' });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find(i => i.path[0] === 'cashRegisterId');
      expect(issue?.message).toBe('v.supplierPayment.cash.required');
    }
  });

  it('BANK_ACCOUNT без рахунку → помилка на bankAccountId', () => {
    const r = supplierPaymentFormSchema.safeParse({ ...base, sourceType: 'BANK_ACCOUNT' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some(i => i.path[0] === 'bankAccountId')).toBe(true);
  });

  it('одночасно банк І каса → помилка (конфлікт джерела)', () => {
    const r = supplierPaymentFormSchema.safeParse({
      ...base,
      sourceType: 'CASH_REGISTER',
      cashRegisterId: ACC,
      bankAccountId: ACC,
    });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.some(i => i.message === 'v.supplierPayment.source.conflict')).toBe(
        true,
      );
  });

  it('amount < 0.01 → помилка', () => {
    const r = supplierPaymentFormSchema.safeParse({
      ...base,
      sourceType: 'CASH_REGISTER',
      cashRegisterId: ACC,
      amount: '0',
    });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.some(i => i.message === 'v.supplierPayment.amount.min')).toBe(true);
  });

  it('порожній method → помилка', () => {
    const r = supplierPaymentFormSchema.safeParse({
      supplierId: SUP,
      method: '',
      amount: '100',
      sourceType: 'CASH_REGISTER',
      cashRegisterId: ACC,
    });
    expect(r.success).toBe(false);
  });

  it('битий documentDate → помилка (validation-parity @IsDateString)', () => {
    const r = supplierPaymentFormSchema.safeParse({
      ...base,
      sourceType: 'CASH_REGISTER',
      cashRegisterId: ACC,
      documentDate: 'not-a-date',
    });
    expect(r.success).toBe(false);
  });

  it('update — усі поля опційні (порожній обʼєкт ok, cross-field на merged у сервісі)', () => {
    expect(supplierPaymentUpdateSchema.safeParse({}).success).toBe(true);
  });
});
