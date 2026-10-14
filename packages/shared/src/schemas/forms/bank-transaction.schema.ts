import { z } from 'zod';
import { optionalString, optionalUuid, moneyString, uuidFieldSchema } from '../validators';

/**
 * Спільні zod-схеми банківських платежів — ЄДИНЕ джерело правди web ↔ api для форм:
 * ручного внесення платежу (BR-BANK-023), рознесення вихідного платежу (BR-BANK-025…034) і
 * рознесення одразу при внесенні (BR-BANK-041).
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

export type BankTxInMatchTypeValue = (typeof BANK_TX_IN_MATCH_TYPE_VALUES)[number];

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

/** Вид рознесення при внесенні платежу (BR-BANK-041): будь-який вхідний або вихідний. */
export type BankTxAllocationTypeValue = BankTxInMatchTypeValue | BankTxOutMatchTypeValue;

/**
 * BR-BANK-025 / 041: які види «Рознести як» можна обрати для напряму платежу. Вхідний — види
 * `match` і переказ; вихідний — усі види `reconcile` (оплата постачальнику при внесенні — лише нова).
 */
export const BANK_TX_ALLOCATION_TYPES_BY_DIRECTION: Readonly<
  Record<BankTxDirectionValue, readonly BankTxAllocationTypeValue[]>
> = {
  IN: [...BANK_TX_IN_MATCH_TYPE_VALUES, 'TRANSFER'],
  OUT: BANK_TX_OUT_MATCH_TYPE_VALUES,
};

export function isBankTxInMatchType(type: string): type is BankTxInMatchTypeValue {
  return (BANK_TX_IN_MATCH_TYPE_VALUES as readonly string[]).includes(type);
}

/**
 * Види, перед якими вікно «Новий банківський платіж» просить підтвердження (BR-BANK-041): вони
 * проводять гроші — оплату постачальнику, повернення клієнту, касову операцію, оплату рахунку.
 */
export const BANK_TX_CREATE_CONFIRM_TYPES: ReadonlySet<string> = new Set([
  'SUPPLIER_PAYMENT',
  'CLIENT_REFUND',
  'CASH_WITHDRAWAL',
  'INVOICE',
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

interface OutgoingRefs {
  type: BankTxOutMatchTypeValue;
  counterpartyId?: string;
  supplierPaymentId?: string;
  expenseCategoryId?: string;
  payrollPeriodId?: string;
  transferBankAccountId?: string;
  cashRegisterId?: string;
}

/**
 * Обов'язкові посилання вихідного виду. `supplierMessage` — текст для оплати постачальнику без
 * постачальника: у вікні рознесення можна обрати й наявну оплату, при внесенні — лише нову.
 */
function refineOutgoingRefs(v: OutgoingRefs, ctx: z.RefinementCtx, supplierMessage: string): void {
  switch (v.type) {
    case 'SUPPLIER_PAYMENT':
      // Наявна оплата вже знає постачальника; для нової він обов'язковий.
      if (!v.supplierPaymentId)
        requireField(ctx, v.counterpartyId, 'counterpartyId', supplierMessage);
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
}

const outgoingRefsShape = {
  type: z.enum(BANK_TX_OUT_MATCH_TYPE_VALUES, { error: 'v.bankTransaction.type.required' }),
  counterpartyId: optionalUuid(),
  supplierPaymentId: optionalUuid(),
  purchaseOrderId: optionalUuid(),
  expenseCategoryId: optionalUuid(),
  payrollPeriodId: optionalUuid(),
  employeeId: optionalUuid(),
  transferBankAccountId: optionalUuid(),
  cashRegisterId: optionalUuid(),
};

export const bankTransactionReconcileFormSchema = z
  .object(outgoingRefsShape)
  .superRefine((v, ctx) => refineOutgoingRefs(v, ctx, 'v.bankTransaction.supplier.required'));
export type BankTransactionReconcileFormValues = z.input<typeof bankTransactionReconcileFormSchema>;
export type BankTransactionReconcilePayload = z.output<typeof bankTransactionReconcileFormSchema>;

// ─── Рознесення при внесенні (BR-BANK-041) ────────────────────────────────────

/**
 * Поля вихідного виду у вікні «Новий банківський платіж»: та сама форма, що й у вікні
 * рознесення, але наявну оплату постачальнику тут обрати не можна — лише нову.
 */
export const bankTransactionCreateOutgoingAllocationFormSchema = z
  .object(outgoingRefsShape)
  .superRefine((v, ctx) => refineOutgoingRefs(v, ctx, 'v.bankTransaction.supplierNew.required'));

function refineIncomingRefs(
  v: { type: string; counterpartyId?: string; invoiceId?: string },
  ctx: z.RefinementCtx,
): void {
  requireField(ctx, v.counterpartyId, 'counterpartyId', 'v.bankTransaction.counterparty.required');
  if (v.type === 'INVOICE')
    requireField(ctx, v.invoiceId, 'invoiceId', 'v.bankTransaction.invoice.required');
}

/** Поля вхідного виду (як у `match`, BR-BANK-010): контрагент завжди, рахунок — для оплати рахунку. */
export const bankTransactionIncomingAllocationSchema = z
  .object({
    type: z.enum(BANK_TX_IN_MATCH_TYPE_VALUES, { error: 'v.bankTransaction.type.required' }),
    counterpartyId: optionalUuid(),
    invoiceId: optionalUuid(),
  })
  .superRefine(refineIncomingRefs);
export type BankTransactionIncomingAllocationValues = z.input<
  typeof bankTransactionIncomingAllocationSchema
>;

const ALLOCATION_TYPE_VALUES = [
  ...BANK_TX_IN_MATCH_TYPE_VALUES,
  ...BANK_TX_OUT_MATCH_TYPE_VALUES,
] as const;

/** Блок `allocation` тіла `POST /bank-statements/transactions` (дзеркалить BankTransactionAllocationDto). */
export const bankTransactionAllocationSchema = z
  .object({
    type: z.enum(ALLOCATION_TYPE_VALUES, { error: 'v.bankTransaction.type.required' }),
    counterpartyId: optionalUuid(),
    invoiceId: optionalUuid(),
    purchaseOrderId: optionalUuid(),
    expenseCategoryId: optionalUuid(),
    payrollPeriodId: optionalUuid(),
    employeeId: optionalUuid(),
    transferBankAccountId: optionalUuid(),
    cashRegisterId: optionalUuid(),
  })
  .superRefine((v, ctx) => {
    const type = v.type;
    if (isBankTxInMatchType(type)) refineIncomingRefs({ ...v, type }, ctx);
    else refineOutgoingRefs({ ...v, type }, ctx, 'v.bankTransaction.supplierNew.required');
  });
export type BankTransactionAllocationPayload = z.output<typeof bankTransactionAllocationSchema>;

/**
 * Повне тіло внесення з рознесенням: поля платежу + необов'язковий `allocation`, вид якого має
 * підходити напряму (BR-BANK-025). Остаточне рішення — за сервером.
 */
export const bankTransactionCreateRequestSchema = bankTransactionCreateFormSchema
  .extend({ allocation: bankTransactionAllocationSchema.optional() })
  .superRefine((v, ctx) => {
    if (!v.allocation) return;
    if (!BANK_TX_ALLOCATION_TYPES_BY_DIRECTION[v.direction].includes(v.allocation.type)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['allocation', 'type'],
        message: 'v.bankTransaction.allocation.direction',
      });
    }
  });
export type BankTransactionCreateRequestPayload = z.output<
  typeof bankTransactionCreateRequestSchema
>;

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
