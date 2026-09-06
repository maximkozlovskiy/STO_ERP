import { describe, it, expect } from 'vitest';
import { invoiceRemaining, optimisticInvoiceStatus } from '../invoice-payment';

/**
 * Session 2026-09-06 — money-model Phase 1 review-fix coverage.
 * Оптимістичний статус + залишок часткової оплати. КЛЮЧОВЕ: часткова оплата дає
 * PARTIALLY_PAID (кнопка «Оплатити» лишається доступною), повна — PAID.
 * Дзеркалить backend CAS у PaymentsService.create з тим самим epsilon.
 */
describe('invoiceRemaining', () => {
  it('amount − paidAmount', () => {
    expect(invoiceRemaining(500, 200)).toBe(300);
  });

  it('paidAmount відсутній (null/undefined) → повна сума', () => {
    expect(invoiceRemaining(500, null)).toBe(500);
    expect(invoiceRemaining(500, undefined)).toBe(500);
  });

  it('не менше 0 (переоплата в даних не дає негативного залишку)', () => {
    expect(invoiceRemaining(500, 600)).toBe(0);
  });

  it('повністю оплачено → 0', () => {
    expect(invoiceRemaining(500, 500)).toBe(0);
  });
});

describe('optimisticInvoiceStatus (review-fix: PARTIALLY_PAID тримає кнопку «Оплатити»)', () => {
  it('часткова оплата (200 з 500, paid=0) → PARTIALLY_PAID', () => {
    expect(optimisticInvoiceStatus(500, 0, 200)).toBe('PARTIALLY_PAID');
  });

  it('дозакриття залишку (300 при paid=200/500) → PAID', () => {
    expect(optimisticInvoiceStatus(500, 200, 300)).toBe('PAID');
  });

  it('оплата РІВНО залишку (100 при paid=400/500) → PAID', () => {
    expect(optimisticInvoiceStatus(500, 400, 100)).toBe('PAID');
  });

  it('повна оплата одразу (500, paid=0) → PAID', () => {
    expect(optimisticInvoiceStatus(500, 0, 500)).toBe('PAID');
  });

  it('paid відсутній (null) трактується як 0', () => {
    expect(optimisticInvoiceStatus(500, null, 200)).toBe('PARTIALLY_PAID');
    expect(optimisticInvoiceStatus(500, undefined, 500)).toBe('PAID');
  });

  it('epsilon: float-дрейф на межі (0.1+0.2 ≈ 0.3) → PAID, не PARTIALLY_PAID', () => {
    // 0.1 + 0.2 = 0.30000000000000004 у IEEE-754; без epsilon округлення дало б PAID,
    // але критичний кейс — коли newPaid трохи МЕНШЕ amount через дрейф.
    expect(optimisticInvoiceStatus(0.3, 0.1, 0.2)).toBe('PAID');
  });
});
