import { describe, it, expect } from 'vitest';
import {
  invoiceHeaderSchema,
  invoiceUpdateSchema,
  invoiceLineSchema,
  invoiceFormSchema,
} from '@sto/shared';

const CP = '11111111-1111-1111-1111-111111111111';

describe('invoiceHeaderSchema (POST /invoices)', () => {
  it('приймає мінімальний валідний рахунок (counterparty+amount)', () => {
    const r = invoiceHeaderSchema.safeParse({ counterpartyId: CP, amount: '100' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.amount).toBe(100); // коерсія рядок→число
  });

  it('відхиляє без counterpartyId', () => {
    expect(invoiceHeaderSchema.safeParse({ amount: '100' }).success).toBe(false);
  });

  it('відхиляє amount < 0.01 (дзеркалить @Min(0.01))', () => {
    const r = invoiceHeaderSchema.safeParse({ counterpartyId: CP, amount: '0' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toContain('0.01');
  });

  it('битий dueDate → помилка (validation-parity: @IsDateString)', () => {
    const r = invoiceHeaderSchema.safeParse({
      counterpartyId: CP,
      amount: '100',
      dueDate: 'not-a-date',
    });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.some(i => i.message === 'Невірний формат дати')).toBe(true);
  });

  it("порожня дата ('') → undefined, не помилка", () => {
    expect(
      invoiceHeaderSchema.safeParse({
        counterpartyId: CP,
        amount: '100',
        dueDate: '',
        documentDate: '',
      }).success,
    ).toBe(true);
  });

  it('невалідний invoiceType → помилка; порожній → undefined', () => {
    expect(
      invoiceHeaderSchema.safeParse({ counterpartyId: CP, amount: '100', invoiceType: 'WEIRD' })
        .success,
    ).toBe(false);
    expect(
      invoiceHeaderSchema.safeParse({ counterpartyId: CP, amount: '100', invoiceType: '' }).success,
    ).toBe(true);
    expect(
      invoiceHeaderSchema.safeParse({ counterpartyId: CP, amount: '100', invoiceType: 'STANDARD' })
        .success,
    ).toBe(true);
  });

  it('update — усі поля опційні (порожній обʼєкт ok)', () => {
    expect(invoiceUpdateSchema.safeParse({}).success).toBe(true);
  });
});

describe('invoiceLineSchema (POST /invoices/:id/lines)', () => {
  it('приймає валідний рядок', () => {
    const r = invoiceLineSchema.safeParse({
      description: 'Робота',
      quantity: '2',
      unitPrice: '150',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.quantity).toBe(2);
      expect(r.data.unitPrice).toBe(150);
    }
  });

  it('відхиляє порожній опис', () => {
    const r = invoiceLineSchema.safeParse({ description: '  ', quantity: '1', unitPrice: '10' });
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.error.issues.some(i => i.message === 'Вкажіть опис позиції')).toBe(true);
  });

  it('відхиляє quantity <= 0 (@Min(0.001))', () => {
    expect(
      invoiceLineSchema.safeParse({ description: 'X', quantity: '0', unitPrice: '10' }).success,
    ).toBe(false);
  });

  it("відхиляє від'ємну ціну (@Min(0))", () => {
    expect(
      invoiceLineSchema.safeParse({ description: 'X', quantity: '1', unitPrice: '-5' }).success,
    ).toBe(false);
  });

  it('vatRate поза 0..100 → помилка; порожній → undefined', () => {
    expect(
      invoiceLineSchema.safeParse({
        description: 'X',
        quantity: '1',
        unitPrice: '10',
        vatRate: '150',
      }).success,
    ).toBe(false);
    expect(
      invoiceLineSchema.safeParse({ description: 'X', quantity: '1', unitPrice: '10', vatRate: 20 })
        .success,
    ).toBe(true);
  });
});

describe('invoiceFormSchema (web-форма з line-items)', () => {
  it('приймає форму з масивом рядків', () => {
    const r = invoiceFormSchema.safeParse({
      counterpartyId: CP,
      lines: [
        { description: 'Робота', quantity: '2', unitPrice: '150' },
        { description: 'Деталь', quantity: '1', unitPrice: '300' },
      ],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.lines).toHaveLength(2);
  });

  it('відхиляє форму з битим рядком (порожній опис)', () => {
    const r = invoiceFormSchema.safeParse({
      counterpartyId: CP,
      lines: [{ description: '', quantity: '1', unitPrice: '10' }],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['lines', 0, 'description']);
  });

  it('порожній масив рядків — валідний (рахунок без позицій)', () => {
    expect(invoiceFormSchema.safeParse({ counterpartyId: CP, lines: [] }).success).toBe(true);
    expect(invoiceFormSchema.safeParse({ counterpartyId: CP }).success).toBe(true); // default []
  });
});
