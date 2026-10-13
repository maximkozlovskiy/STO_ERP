import type { CashOperationReason } from '@prisma/client';

type LabelLocale = 'uk' | 'en';

/**
 * Назви приводів касової операції для ТЕКСТІВ ПОМИЛОК api (`{{reason}}` у `err.cash.reason*` та
 * `err.expenseCategory.defaultReason*`). Підписи інтерфейсу живуть у web
 * (`i18n/locales/<мова>/cash.json`) — api їх прочитати не може, тому тут власний перелік.
 * `Record<CashOperationReason, …>` не дасть додати привід у схему й забути назву.
 */
const CASH_REASON_LABELS: Record<LabelLocale, Record<CashOperationReason, string>> = {
  uk: {
    SALE_PAYMENT: 'Оплата контрагента',
    SUPPLIER_REFUND_IN: 'Повернення від постачальника',
    ADVANCE_RETURN: 'Повернення підзвіту',
    BANK_WITHDRAWAL: 'Отримання з банку',
    OWNER_IN: 'Внесок власника',
    COLLECTION: 'Інкасація',
    MANUAL_IN: 'Внесення',
    REFUND: 'Повернення клієнту',
    SUPPLIER_PAYMENT: 'Оплата постачальнику',
    ADVANCE_ISSUE: 'Під звіт',
    BANK_DEPOSIT: 'Здача в банк',
    OWNER_OUT: 'Вилучення власником',
    EXPENSE: 'Витрата',
    PAYROLL: 'Виплата ЗП',
    MANUAL_OUT: 'Видача',
  },
  en: {
    SALE_PAYMENT: 'Counterparty payment',
    SUPPLIER_REFUND_IN: 'Refund from supplier',
    ADVANCE_RETURN: 'Advance return',
    BANK_WITHDRAWAL: 'Bank withdrawal',
    OWNER_IN: 'Owner contribution',
    COLLECTION: 'Collection',
    MANUAL_IN: 'Cash in',
    REFUND: 'Customer refund',
    SUPPLIER_PAYMENT: 'Supplier payment',
    ADVANCE_ISSUE: 'Advance to employee',
    BANK_DEPOSIT: 'Bank deposit',
    OWNER_OUT: 'Owner withdrawal',
    EXPENSE: 'Expense',
    PAYROLL: 'Payroll payout',
    MANUAL_OUT: 'Cash out',
  },
};

export function cashReasonLabel(reason: CashOperationReason, locale: string): string {
  const labels = locale === 'en' ? CASH_REASON_LABELS.en : CASH_REASON_LABELS.uk;
  return labels[reason] ?? reason;
}
