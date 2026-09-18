import { z } from 'zod';
import { optionalString, optionalUuid, optionalDateString, moneyString } from '../validators';

/**
 * Спільна zod-схема оплати постачальнику (SupplierPayment) — ЄДИНЕ джерело правди web ↔ api.
 *
 * Крос-польове правило sourceType↔account раніше жило ЛИШЕ у service.assertSourceConsistency
 * (не в class-validator DTO) — тепер у superRefine (per-field помилки на bankAccountId/cashRegisterId).
 * Бек-service guard лишається як defense-in-depth. Валюта — серверна (резолвиться з рахунку), у формі немає.
 */

export const PAYMENT_SOURCE_TYPE_VALUES = ['BANK_ACCOUNT', 'CASH_REGISTER'] as const;
export type PaymentSourceTypeValue = (typeof PAYMENT_SOURCE_TYPE_VALUES)[number];

const supplierPaymentShape = {
  supplierId: z.string().uuid('v.supplierPayment.supplier.required'),
  sourceType: z.enum(PAYMENT_SOURCE_TYPE_VALUES, {
    errorMap: () => ({ message: 'v.supplierPayment.sourceType.required' }),
  }),
  bankAccountId: optionalUuid(),
  cashRegisterId: optionalUuid(),
  purchaseOrderId: optionalUuid(),
  // amount — UA-кома підтримується (moneyString); мінімум 0.01 (дзеркалить @Min(0.01)).
  amount: moneyString().pipe(z.number().min(0.01, 'v.supplierPayment.amount.min')),
  method: z.string().trim().min(1, 'v.supplierPayment.method.required'),
  notes: optionalString(),
  documentDate: optionalDateString(),
};

// Крос-польова перевірка джерела коштів (дзеркалить assertSourceConsistency).
const sourceRefine = (
  v: {
    sourceType: string;
    bankAccountId?: string | undefined;
    cashRegisterId?: string | undefined;
  },
  ctx: z.RefinementCtx,
) => {
  if (v.sourceType === 'BANK_ACCOUNT') {
    if (!v.bankAccountId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bankAccountId'],
        message: 'v.supplierPayment.bank.required',
      });
    }
    if (v.cashRegisterId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cashRegisterId'],
        message: 'v.supplierPayment.source.conflict',
      });
    }
  } else if (v.sourceType === 'CASH_REGISTER') {
    if (!v.cashRegisterId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cashRegisterId'],
        message: 'v.supplierPayment.cash.required',
      });
    }
    if (v.bankAccountId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bankAccountId'],
        message: 'v.supplierPayment.source.conflict',
      });
    }
  }
};

export const supplierPaymentFormSchema = z.object(supplierPaymentShape).superRefine(sourceRefine);
export type SupplierPaymentFormValues = z.infer<typeof supplierPaymentFormSchema>;
export type SupplierPaymentFormInput = z.input<typeof supplierPaymentFormSchema>;

// Бек-схеми: create = форма (той самий superRefine); update — усі поля опційні (cross-field на merged
// перевіряє service; тут не рефайнимо, щоб PATCH одного поля не вимагав повного набору).
export const supplierPaymentCreateSchema = supplierPaymentFormSchema;
export type SupplierPaymentCreateValues = SupplierPaymentFormValues;

export const supplierPaymentUpdateSchema = z.object(supplierPaymentShape).partial();
export type SupplierPaymentUpdateValues = z.infer<typeof supplierPaymentUpdateSchema>;
