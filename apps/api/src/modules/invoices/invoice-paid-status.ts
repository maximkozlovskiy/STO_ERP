import { InvoiceStatus } from '@prisma/client';
import { kyivToday } from '../../common/utils/kyiv-date';

/**
 * BR-INV-025: рахунок прострочений, коли термін оплати минув — `dueDate` раніше за сьогоднішню
 * київську дату. Та сама умова, що в нічній позначці (`invoice-overdue.processor`: `dueDate < kyivToday()`).
 */
export function isInvoicePastDue(
  dueDate: Date | null | undefined,
  today: Date = kyivToday(),
): boolean {
  return dueDate != null && dueDate.getTime() < today.getTime();
}

/**
 * BR-INV-025: статус виставленого рахунку від сплаченого — одна формула для оплати, сторно й
 * дзеркала рахунку наряду. Повністю сплачений → «Оплачено»; інакше прострочений → «Прострочено»
 * одразу (не чекаючи нічної позначки); частково сплачений → «Частково оплачено»; нічого —
 * «Виставлено» (рахунок, що вже «Прострочено», ним і лишається).
 */
export function invoiceStatusForPaid(
  current: InvoiceStatus,
  amount: number,
  paid: number,
  dueDate: Date | null | undefined,
  today: Date = kyivToday(),
): InvoiceStatus {
  if (amount > 0 && paid >= amount - 1e-9) return InvoiceStatus.PAID;
  if (isInvoicePastDue(dueDate, today)) return InvoiceStatus.OVERDUE;
  if (paid > 1e-9) return InvoiceStatus.PARTIALLY_PAID;
  return current === InvoiceStatus.OVERDUE ? InvoiceStatus.OVERDUE : InvoiceStatus.SENT;
}
