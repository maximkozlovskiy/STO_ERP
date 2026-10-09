import { z } from 'zod';
import { optionalString, optionalUuid, moneyString, uuidFieldSchema } from '../validators';

/**
 * Спільні zod-схеми банківських платежів — ЄДИНЕ джерело правди web ↔ api для двох форм:
 * ручного внесення платежу (BR-BANK-023) і рознесення вихідного платежу (BR-BANK-025…034).
 *
 * Бек дублює ці перевірки у class-validator DTO й у сервісі (defense-in-depth): які поля
 * обов'язкові для якого виду рознесення, остаточно вирішує сервер.
 */

export const BANK_TX_DIRECTION_VALUES = ['IN', 'OUT'] as const;
export type BankTxDirectionValue = (typeof BANK_TX_DIRECTION_VALUES)[number];

/** Види рознесення вхідного платежу (`POST …/match`). */
export const BANK_TX_IN_MATCH_TYPE_VALUES = [
  'PREPAYMENT',
  'SERVICE',
  'INVOICE',
  'REFUND',
  'OTHER',
] as const;

/** Види рознесення вихідного платежу (`POST …/reconcile`). TRANSFER дозволений і для вхідного. */
export const BANK_TX_OUT_MATCH_TYPE_VALUES = [
  'SUPPLIER_PAYMENT',
  'CLIENT_REFUND',
  'EXPENSE',
  'PAYROLL',
  'TRANSFER',
  'CASH_WITHDRAWAL',
] as const;
export type BankTxOutMatchTypeValue = (typeof BANK_TX_OUT_MATCH_TYPE_VALUES)[number];

/**
 * Види рознесення, що створюють проведення або касову операцію: перед ними UI показує
 * підтвердження, а їх скасування робить зворотний запис (BR-BANK-039).
 */
export const BANK_TX_POSTING_MATCH_TYPES: ReadonlySet<string> = new Set([
  'SUPPLIER_PAYMENT',
  'CLIENT_REFUND',
  'CASH_WITHDRAWAL',
]);

/** Довжина причини скасування рознесення і призначення ручного платежу. */
export const BANK_TX_REASON_MAX_LENGTH = 500;

const CALENDAR_DATE = /^(?!0000)\d{4}-\d{2}-\d{2}$/;

// ─── Ручне внесення ───────────────────────────────────────────────────────────

export const bankTransactionCreateFormSchema = z.object({
  bankAccountId: uuidFieldSchema.or(z.literal('')).refine(v => v !== '', {
    message: 'v.bankTransaction.bankAccount.required',
  }),
  direction: z.enum(BANK_TX_DIRECTION_VALUES, { error: 'v.bankTransaction.direction.required' }),
  // UA-кома підтримується (moneyString); мінімум 0.01 (дзеркалить @Min(0.01)).
  amount: moneyString().pipe(z.number().min(0.01, 'v.bankTransaction.amount.min')),
  // Календарна дата без часу (BR-BANK-021).
  operationDate: z.string().regex(CALENDAR_DATE, 'v.bankTransaction.date.required'),
  payerName: optionalString(),
  payerIban: optionalString(),
  payerEdrpou: optionalString(),
  purpose: z.preprocess(
    v => (v === '' || v === null ? undefined : v),
    z.string().max(BANK_TX_REASON_MAX_LENGTH, 'v.bankTransaction.purpose.max').optional(),
  ),
});
export type BankTransactionCreateFormValues = z.input<typeof bankTransactionCreateFormSchema>;
export type BankTransactionCreatePayload = z.output<typeof bankTransactionCreateFormSchema>;

// ─── Рознесення вихідного ─────────────────────────────────────────────────────

const requireField = (
  ctx: z.RefinementCtx,
  value: string | undefined,
  path: string,
  message: string,
) => {
  if (!value) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
};

export const bankTransactionReconcileFormSchema = z
  .object({
    type: z.enum(BANK_TX_OUT_MATCH_TYPE_VALUES, { error: 'v.bankTransaction.type.required' }),
    counterpartyId: optionalUuid(),
    supplierPaymentId: optionalUuid(),
    purchaseOrderId: optionalUuid(),
    expenseCategoryId: optionalUuid(),
    payrollPeriodId: optionalUuid(),
    employeeId: optionalUuid(),
    transferBankAccountId: optionalUuid(),
    cashRegisterId: optionalUuid(),
  })
  .superRefine((v, ctx) => {
    switch (v.type) {
      case 'SUPPLIER_PAYMENT':
        // Наявна оплата вже знає постачальника; для нової він обов'язковий.
        if (!v.supplierPaymentId)
          requireField(
            ctx,
            v.counterpartyId,
            'counterpartyId',
            'v.bankTransaction.supplier.required',
          );
        break;
      case 'CLIENT_REFUND':
        requireField(ctx, v.counterpartyId, 'counterpartyId', 'v.bankTransaction.client.required');
        break;
      case 'EXPENSE':
        requireField(
          ctx,
          v.expenseCategoryId,
          'expenseCategoryId',
          'v.bankTransaction.expenseCategory.required',
        );
        break;
      case 'PAYROLL':
        requireField(
          ctx,
          v.payrollPeriodId,
          'payrollPeriodId',
          'v.bankTransaction.payrollPeriod.required',
        );
        break;
      case 'TRANSFER':
        requireField(
          ctx,
          v.transferBankAccountId,
          'transferBankAccountId',
          'v.bankTransaction.transferAccount.required',
        );
        break;
      case 'CASH_WITHDRAWAL':
        requireField(
          ctx,
          v.cashRegisterId,
          'cashRegisterId',
          'v.bankTransaction.cashRegister.required',
        );
        break;
    }
  });
export type BankTransactionReconcileFormValues = z.input<typeof bankTransactionReconcileFormSchema>;
export type BankTransactionReconcilePayload = z.output<typeof bankTransactionReconcileFormSchema>;

// ─── Скасування рознесення ────────────────────────────────────────────────────

export const bankTransactionUnreconcileFormSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'v.bankTransaction.unmatchReason.required')
    .max(BANK_TX_REASON_MAX_LENGTH, 'v.bankTransaction.unmatchReason.max'),
});
export type BankTransactionUnreconcileFormValues = z.input<
  typeof bankTransactionUnreconcileFormSchema
>;
