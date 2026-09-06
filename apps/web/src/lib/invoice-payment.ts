// Чиста логіка часткової оплати рахунку (money-model Phase 1). Винесено з
// invoices/page.tsx щоб оптимістичний статус і залишок були одиницею правди й
// покривались unit-тестами (review-fix «Оплатити лишається доступним при частковій оплаті»).
//
// Дзеркалить backend CAS у PaymentsService.create:
//   newPaid >= amount − epsilon ? PAID : PARTIALLY_PAID
// з тим самим epsilon (1e-9) — щоб FE-оптимістичний стан не розходився з persist-станом.

const EPSILON = 1e-9;

/** Залишок до сплати = сума − уже сплачено, не менше 0. */
export function invoiceRemaining(amount: number, paidAmount?: number | null): number {
  return Math.max(amount - (paidAmount ?? 0), 0);
}

/**
 * Оптимістичний статус рахунку ПІСЛЯ оплати `payAmount`.
 * Повне покриття залишку → 'PAID'; часткове → 'PARTIALLY_PAID'
 * (тоді кнопка «Оплатити» лишається доступною).
 */
export function optimisticInvoiceStatus(
  amount: number,
  prevPaid: number | null | undefined,
  payAmount: number,
): 'PAID' | 'PARTIALLY_PAID' {
  const newPaidTotal = (prevPaid ?? 0) + payAmount;
  return newPaidTotal >= amount - EPSILON ? 'PAID' : 'PARTIALLY_PAID';
}
