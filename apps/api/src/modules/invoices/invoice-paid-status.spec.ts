/**
 * Статус виставленого рахунку від сплаченого — одна формула для оплати, сторно й дзеркала рахунку
 * наряду (BR-INV-025, рішення власника 2026-10-30, TECH-DEBT (б) №44): прострочений рахунок, що
 * не сплачений повністю, — «Прострочено» одразу, не чекаючи нічної позначки.
 *
 * Межа «прострочено» — та сама, що в нічній позначці (`invoice-overdue.processor`): термін оплати
 * раніше за сьогоднішню київську дату (`kyivToday()`, UTC-північ київської дати).
 */
import { describe, it, expect } from 'vitest';
import { InvoiceStatus } from '@prisma/client';
import { invoiceStatusForPaid, isInvoicePastDue } from './invoice-paid-status';

const TODAY = new Date('2026-10-30T00:00:00.000Z');
const YESTERDAY = new Date('2026-10-29T00:00:00.000Z');
const TOMORROW = new Date('2026-10-31T00:00:00.000Z');

describe('isInvoicePastDue — термін оплати минув (BR-INV-025)', () => {
  // guards: BR-INV-025
  it.each([
    ['учора', YESTERDAY, true],
    ['сьогодні — ще не прострочено', TODAY, false],
    ['завтра', TOMORROW, false],
    ['терміну немає', null, false],
  ] as const)('%s → %s', (_label, dueDate, expected) => {
    expect(isInvoicePastDue(dueDate, TODAY)).toBe(expected);
  });
});

describe('invoiceStatusForPaid — статус від сплаченого (BR-INV-025)', () => {
  // guards: BR-INV-025
  it.each([
    // [поточний, сума, сплачено, термін, очікуваний]
    ['SENT', 1000, 1000, YESTERDAY, 'PAID'],
    ['OVERDUE', 1000, 1000, YESTERDAY, 'PAID'],
    ['SENT', 1000, 400, YESTERDAY, 'OVERDUE'],
    ['PAID', 1000, 0, YESTERDAY, 'OVERDUE'],
    ['PARTIALLY_PAID', 1000, 600, YESTERDAY, 'OVERDUE'],
    ['SENT', 1000, 400, TODAY, 'PARTIALLY_PAID'],
    ['PAID', 1000, 0, TOMORROW, 'SENT'],
    ['PAID', 1000, 600, null, 'PARTIALLY_PAID'],
    ['OVERDUE', 1000, 0, TOMORROW, 'OVERDUE'],
  ] as const)(
    '%s, сума %d, сплачено %d, термін %s → %s',
    (current, amount, paid, due, expected) => {
      expect(invoiceStatusForPaid(current as InvoiceStatus, amount, paid, due, TODAY)).toBe(
        expected,
      );
    },
  );

  // guards: BR-INV-025
  it('рахунок на 0 — не «Оплачено» і не позначається простроченим, поки термін не минув', () => {
    expect(invoiceStatusForPaid(InvoiceStatus.SENT, 0, 0, TOMORROW, TODAY)).toBe('SENT');
  });
});
