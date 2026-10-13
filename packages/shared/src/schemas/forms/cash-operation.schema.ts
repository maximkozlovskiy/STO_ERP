import { z } from 'zod';
import { optionalUuid, moneyString } from '../validators';

/**
 * Ручна касова операція — ЄДИНЕ джерело правди web ↔ api (BR-CASH-016…021).
 *
 * `CASH_REASON_RULES` каже для кожного приводу: напрям, чи можна вносити вручну, чи обов'язкові
 * контрагент (і в якій ролі) та працівник, який документ може бути підставою. Форма, zod-схема,
 * сервер і тести читають саме цю таблицю — нового приводу не можна додати «лише на фронті».
 * Роль контрагента, його належність організації й належність підстави контрагентові остаточно
 * перевіряє сервер (`CashDeskService`).
 */

export const CASH_DIRECTION_VALUES = ['IN', 'OUT'] as const;
export type CashDirectionValue = (typeof CASH_DIRECTION_VALUES)[number];

export const CASH_REASON_VALUES = [
  'SALE_PAYMENT',
  'SUPPLIER_REFUND_IN',
  'ADVANCE_RETURN',
  'BANK_WITHDRAWAL',
  'OWNER_IN',
  'COLLECTION',
  'MANUAL_IN',
  'REFUND',
  'SUPPLIER_PAYMENT',
  'ADVANCE_ISSUE',
  'BANK_DEPOSIT',
  'OWNER_OUT',
  'EXPENSE',
  'PAYROLL',
  'MANUAL_OUT',
] as const;
export type CashReasonValue = (typeof CASH_REASON_VALUES)[number];

/** Документ-підстава касової операції (не плутати з платіжним документом `documentType`). */
export const CASH_BASE_DOCUMENT_VALUES = ['WorkOrder', 'PurchaseOrder'] as const;
export type CashBaseDocumentValue = (typeof CASH_BASE_DOCUMENT_VALUES)[number];

export interface CashReasonRule {
  direction: CashDirectionValue;
  /** false — привід ставить лише система (зарплата з відомості); вручну заборонено. */
  manual: boolean;
  /** Обов'язковий контрагент і роль, у якій він має виступати. */
  counterparty?: 'client' | 'supplier';
  /** Обов'язковий працівник. */
  employee?: true;
  /** Який документ може бути підставою (завжди необов'язковий). */
  baseDocument?: CashBaseDocumentValue;
  /** Привід обов'язково потребує статті руху коштів. */
  categoryRequired?: true;
}

/**
 * Назви приводів — єдине джерело для ТЕКСТІВ ПОМИЛОК api (`{{reason}}` у `err.cash.reason*` та
 * `err.expenseCategory.defaultReason*`). Підписи інтерфейсу живуть у каталозі web
 * (`i18n/locales/<мова>/cash.json`, ключі `reasons.*`) і мають збігатися з цими — це стереже
 * тест-інваріант `apps/web/src/i18n/cashReasonLabels.parity.test.ts`. `Record<CashReasonValue, …>` не дасть
 * додати привід і забути назву.
 */
export const CASH_REASON_LABELS: Record<'uk' | 'en', Record<CashReasonValue, string>> = {
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
    BANK_WITHDRAWAL: 'Withdrawal from bank',
    OWNER_IN: 'Owner contribution',
    COLLECTION: 'Collection',
    MANUAL_IN: 'Cash in',
    REFUND: 'Customer refund',
    SUPPLIER_PAYMENT: 'Supplier payment',
    ADVANCE_ISSUE: 'Advance to employee',
    BANK_DEPOSIT: 'Deposit to bank',
    OWNER_OUT: 'Owner withdrawal',
    EXPENSE: 'Expense',
    PAYROLL: 'Payroll payout',
    MANUAL_OUT: 'Cash out',
  },
};

export const CASH_REASON_RULES: Record<CashReasonValue, CashReasonRule> = {
  // ── Внесення ──
  SALE_PAYMENT: {
    direction: 'IN',
    manual: true,
    counterparty: 'client',
    baseDocument: 'WorkOrder',
  },
  SUPPLIER_REFUND_IN: {
    direction: 'IN',
    manual: true,
    counterparty: 'supplier',
    baseDocument: 'PurchaseOrder',
  },
  ADVANCE_RETURN: { direction: 'IN', manual: true, employee: true },
  BANK_WITHDRAWAL: { direction: 'IN', manual: true },
  OWNER_IN: { direction: 'IN', manual: true },
  COLLECTION: { direction: 'IN', manual: true },
  MANUAL_IN: { direction: 'IN', manual: true },
  // ── Видача ──
  REFUND: { direction: 'OUT', manual: true, counterparty: 'client', baseDocument: 'WorkOrder' },
  SUPPLIER_PAYMENT: {
    direction: 'OUT',
    manual: true,
    counterparty: 'supplier',
    baseDocument: 'PurchaseOrder',
  },
  ADVANCE_ISSUE: { direction: 'OUT', manual: true, employee: true },
  BANK_DEPOSIT: { direction: 'OUT', manual: true },
  OWNER_OUT: { direction: 'OUT', manual: true },
  EXPENSE: { direction: 'OUT', manual: true, categoryRequired: true },
  PAYROLL: { direction: 'OUT', manual: false },
  MANUAL_OUT: { direction: 'OUT', manual: true },
};

/** Приводи, які можна обрати вручну для напряму, — у порядку таблиці вище. */
export function manualCashReasons(direction: CashDirectionValue): CashReasonValue[] {
  return CASH_REASON_VALUES.filter(r => {
    const rule = CASH_REASON_RULES[r];
    return rule.manual && rule.direction === direction;
  });
}

/** Приводи, які приймальня (RECEPTIONIST) може вносити в касу сама. */
export const RECEPTIONIST_CASH_REASONS: readonly CashReasonValue[] = ['SALE_PAYMENT'];

const cashOperationShape = {
  direction: z.enum(CASH_DIRECTION_VALUES, { error: 'v.cashOperation.direction.required' }),
  reason: z.enum(CASH_REASON_VALUES, { error: 'v.cashOperation.reason.required' }),
  // UA-кома підтримується (moneyString); мінімум 0.01.
  amount: moneyString().pipe(z.number().min(0.01, 'v.cashOperation.amount.min')),
  expenseCategoryId: optionalUuid(),
  counterpartyId: optionalUuid(),
  employeeId: optionalUuid(),
  baseDocumentType: z.preprocess(
    v => (v === '' || v === null ? undefined : v),
    z.enum(CASH_BASE_DOCUMENT_VALUES).optional(),
  ),
  baseDocumentId: optionalUuid(),
  notes: z.preprocess(
    v => (v === '' || v === null ? undefined : v),
    z.string().max(500, 'v.cashOperation.notes.max').optional(),
  ),
};

type CashOperationShape = {
  direction: CashDirectionValue;
  reason: CashReasonValue;
  expenseCategoryId?: string | undefined;
  counterpartyId?: string | undefined;
  employeeId?: string | undefined;
  baseDocumentType?: CashBaseDocumentValue | undefined;
  baseDocumentId?: string | undefined;
};

// Крос-польові правила за таблицею приводів (сервер повторює їх і додає перевірки по базі).
const reasonRefine = (v: CashOperationShape, ctx: z.RefinementCtx) => {
  const rule = CASH_REASON_RULES[v.reason];
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

  if (!rule.manual) issue('reason', 'v.cashOperation.reason.autoOnly');
  if (rule.direction !== v.direction) issue('reason', 'v.cashOperation.reason.direction');
  if (rule.counterparty && !v.counterpartyId) {
    issue('counterpartyId', 'v.cashOperation.counterparty.required');
  }
  if (rule.employee && !v.employeeId) issue('employeeId', 'v.cashOperation.employee.required');
  if (rule.categoryRequired && !v.expenseCategoryId) {
    issue('expenseCategoryId', 'v.cashOperation.category.required');
  }
  // Підстава: тип і id — лише разом, і лише того типу, який дозволяє привід.
  if (!!v.baseDocumentType !== !!v.baseDocumentId) {
    issue('baseDocumentId', 'v.cashOperation.baseDocument.incomplete');
  } else if (v.baseDocumentType && v.baseDocumentType !== rule.baseDocument) {
    issue('baseDocumentId', 'v.cashOperation.baseDocument.notAllowed');
  }
};

export const cashOperationSchema = z.object(cashOperationShape).superRefine(reasonRefine);

export type CashOperationFormInput = z.input<typeof cashOperationSchema>;
export type CashOperationFormValues = z.output<typeof cashOperationSchema>;
