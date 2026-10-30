/**
 * Рознесення одразу при внесенні банківського платежу (BR-BANK-041) — спільні схеми web ↔ api.
 *
 * Очікування — з тексту правил у дос'є (`docs/objects/bank-statements.md`): вид рознесення
 * залежить від напряму (BR-BANK-025: вхідний — види `match` і переказ, вихідний — види
 * `reconcile`); вхідний вид потребує контрагента, «Оплата рахунку» — ще й рахунку (BR-BANK-010);
 * оплата постачальнику при внесенні — лише нова, тож постачальник обов'язковий.
 *
 * Mutation-verify: прибрати перевірку напряму в `bankTransactionCreateRequestSchema` → кейси
 * «не підходить напряму»; прибрати `requireField(… counterpartyId …)` з вхідних → «без
 * контрагента»; `'TRANSFER'` прибрати з IN → «переказ дозволений для обох напрямків».
 */
import { describe, it, expect } from 'vitest';
import {
  BANK_TX_ALLOCATION_TYPES_BY_DIRECTION,
  BANK_TX_CREATE_CONFIRM_TYPES,
  BANK_TX_IN_MATCH_TYPE_VALUES,
  BANK_TX_OUT_MATCH_TYPE_VALUES,
  bankTransactionAllocationSchema,
  bankTransactionCreateFormSchema,
  bankTransactionCreateOutgoingAllocationFormSchema,
  bankTransactionCreateRequestSchema,
  bankTransactionIncomingAllocationSchema,
  bankTransactionReconcileFormSchema,
} from './bank-transaction.schema';
import { kyivTodayYmd } from '../../constants';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

/** Усі помилки у вигляді «шлях: ключ» (або порожній список, якщо схема прийняла). */
function issues(schema: { safeParse: (v: unknown) => unknown }, input: unknown): string[] {
  const parsed = schema.safeParse(input) as {
    success: boolean;
    error?: { issues: { path: PropertyKey[]; message: string }[] };
  };
  if (parsed.success) return [];
  return parsed.error!.issues.map(i => `${i.path.map(String).join('.')}: ${i.message}`);
}

const payment = (over: Record<string, unknown> = {}) => ({
  bankAccountId: UUID_A,
  direction: 'IN',
  amount: '1250,50',
  operationDate: '2026-10-14',
  ...over,
});

describe('види «Рознести як» за напрямом', () => {
  // guards: BR-BANK-025, BR-BANK-041, BR-BANK-046
  it('вхідний — види match, повернення від постачальника і переказ; вихідний — види reconcile без повернення від постачальника', () => {
    expect(BANK_TX_ALLOCATION_TYPES_BY_DIRECTION.IN).toEqual([
      ...BANK_TX_IN_MATCH_TYPE_VALUES,
      'SUPPLIER_REFUND_IN',
      'TRANSFER',
    ]);
    expect(BANK_TX_ALLOCATION_TYPES_BY_DIRECTION.OUT).toEqual(
      BANK_TX_OUT_MATCH_TYPE_VALUES.filter(t => t !== 'SUPPLIER_REFUND_IN'),
    );
    expect(BANK_TX_ALLOCATION_TYPES_BY_DIRECTION.OUT).not.toContain('SUPPLIER_REFUND_IN');
  });

  // guards: BR-BANK-041, BR-BANK-046
  it('підтвердження перед видами, що проводять гроші: постачальник, повернення, каса, рахунок', () => {
    expect([...BANK_TX_CREATE_CONFIRM_TYPES].sort()).toEqual(
      [
        'CASH_WITHDRAWAL',
        'CLIENT_REFUND',
        'INVOICE',
        'SUPPLIER_PAYMENT',
        'SUPPLIER_REFUND_IN',
      ].sort(),
    );
  });
});

describe('bankTransactionIncomingAllocationSchema — вхідний вид', () => {
  // guards: BR-BANK-010, BR-BANK-041
  it.each(['PREPAYMENT', 'SERVICE', 'REFUND', 'OTHER'])('%s з контрагентом проходить', type => {
    expect(
      issues(bankTransactionIncomingAllocationSchema, { type, counterpartyId: UUID_A }),
    ).toEqual([]);
  });

  // guards: BR-BANK-010, BR-BANK-041
  it('без контрагента → «Оберіть контрагента»', () => {
    expect(
      issues(bankTransactionIncomingAllocationSchema, { type: 'SERVICE', counterpartyId: '' }),
    ).toEqual(['counterpartyId: v.bankTransaction.counterparty.required']);
  });

  // guards: BR-BANK-010, BR-BANK-041
  it('«Оплата рахунку» без рахунку → помилка поля рахунку; з рахунком — проходить', () => {
    expect(
      issues(bankTransactionIncomingAllocationSchema, { type: 'INVOICE', counterpartyId: UUID_A }),
    ).toEqual(['invoiceId: v.bankTransaction.invoice.required']);
    expect(
      issues(bankTransactionIncomingAllocationSchema, {
        type: 'INVOICE',
        counterpartyId: UUID_A,
        invoiceId: UUID_B,
      }),
    ).toEqual([]);
  });
});

describe('bankTransactionAllocationSchema — блок allocation тіла запиту', () => {
  // guards: BR-BANK-041, BR-BANK-028
  it('оплата постачальнику без постачальника → «Оберіть постачальника» (наявну оплату тут не обрати)', () => {
    expect(issues(bankTransactionAllocationSchema, { type: 'SUPPLIER_PAYMENT' })).toEqual([
      'counterpartyId: v.bankTransaction.supplierNew.required',
    ]);
    expect(
      issues(bankTransactionCreateOutgoingAllocationFormSchema, {
        type: 'SUPPLIER_PAYMENT',
        counterpartyId: '',
      }),
    ).toEqual(['counterpartyId: v.bankTransaction.supplierNew.required']);
  });

  // У вікні рознесення вже внесеного рядка текст лишається «або наявну оплату».
  // guards: BR-BANK-027
  it('вікно рознесення: текст про наявну оплату не змінився', () => {
    expect(issues(bankTransactionReconcileFormSchema, { type: 'SUPPLIER_PAYMENT' })).toEqual([
      'counterpartyId: v.bankTransaction.supplier.required',
    ]);
  });

  // guards: BR-BANK-041, BR-BANK-031, BR-BANK-033, BR-BANK-034
  it.each([
    ['EXPENSE', 'expenseCategoryId', 'v.bankTransaction.expenseCategory.required'],
    ['TRANSFER', 'transferBankAccountId', 'v.bankTransaction.transferAccount.required'],
    ['CASH_WITHDRAWAL', 'cashRegisterId', 'v.bankTransaction.cashRegister.required'],
    ['CLIENT_REFUND', 'counterpartyId', 'v.bankTransaction.client.required'],
    ['INVOICE', 'counterpartyId', 'v.bankTransaction.counterparty.required'],
  ])('%s без обов’язкового поля → помилка %s', (type, field, key) => {
    expect(issues(bankTransactionAllocationSchema, { type })).toContain(`${field}: ${key}`);
  });

  // guards: BR-BANK-046
  it('повернення від постачальника без постачальника → «Оберіть постачальника»; з ним — проходить і як вхідний вид', () => {
    expect(issues(bankTransactionAllocationSchema, { type: 'SUPPLIER_REFUND_IN' })).toEqual([
      'counterpartyId: v.bankTransaction.supplier.required',
    ]);
    expect(
      issues(bankTransactionIncomingAllocationSchema, {
        type: 'SUPPLIER_REFUND_IN',
        counterpartyId: UUID_A,
      }),
    ).toEqual([]);
    expect(
      issues(bankTransactionCreateRequestSchema, {
        ...payment(),
        allocation: { type: 'SUPPLIER_REFUND_IN', counterpartyId: UUID_A },
      }),
    ).toEqual([]);
    expect(
      issues(bankTransactionCreateRequestSchema, {
        ...payment({ direction: 'OUT' }),
        allocation: { type: 'SUPPLIER_REFUND_IN', counterpartyId: UUID_A },
      }),
    ).toEqual(['allocation.type: v.bankTransaction.allocation.direction']);
  });

  // guards: BR-BANK-041
  it('невідомий вид → «Оберіть вид рознесення»', () => {
    expect(issues(bankTransactionAllocationSchema, { type: 'GIFT' })).toEqual([
      'type: v.bankTransaction.type.required',
    ]);
  });
});

describe('bankTransactionCreateRequestSchema — вид проти напряму', () => {
  // guards: BR-BANK-041
  it('без allocation — як раніше, проходить; сума з комою стає числом', () => {
    const parsed = bankTransactionCreateRequestSchema.safeParse(payment());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.amount).toBe(1250.5);
  });

  // guards: BR-BANK-025, BR-BANK-041
  it.each(['SUPPLIER_PAYMENT', 'CLIENT_REFUND', 'EXPENSE', 'PAYROLL', 'CASH_WITHDRAWAL'])(
    'вихідний вид %s на вхідному платежі → «не підходить напряму»',
    type => {
      expect(
        issues(
          bankTransactionCreateRequestSchema,
          payment({
            allocation: {
              type,
              counterpartyId: UUID_A,
              expenseCategoryId: UUID_A,
              payrollPeriodId: UUID_A,
              cashRegisterId: UUID_A,
            },
          }),
        ),
      ).toEqual(['allocation.type: v.bankTransaction.allocation.direction']);
    },
  );

  // guards: BR-BANK-025, BR-BANK-041
  it.each(['PREPAYMENT', 'SERVICE', 'INVOICE', 'REFUND', 'OTHER'])(
    'вхідний вид %s на вихідному платежі → «не підходить напряму»',
    type => {
      expect(
        issues(
          bankTransactionCreateRequestSchema,
          payment({
            direction: 'OUT',
            allocation: { type, counterpartyId: UUID_A, invoiceId: UUID_B },
          }),
        ),
      ).toEqual(['allocation.type: v.bankTransaction.allocation.direction']);
    },
  );

  // guards: BR-BANK-033, BR-BANK-041
  it.each(['IN', 'OUT'])('переказ дозволений для напряму %s', direction => {
    expect(
      issues(
        bankTransactionCreateRequestSchema,
        payment({ direction, allocation: { type: 'TRANSFER', transferBankAccountId: UUID_B } }),
      ),
    ).toEqual([]);
  });
});

// Майбутня дата ручного платежу (TECH-DEBT §8 «Вихідні банківські платежі» п.10): форма відхиляє
// день після сьогоднішнього за Києвом; сервер перевіряє те саме (bank-reconciliation.createManual).
describe('bankTransactionCreateFormSchema — дата операції не в майбутньому', () => {
  const base = {
    bankAccountId: UUID_A,
    direction: 'IN',
    amount: '100',
  };
  const dateIssues = (operationDate: string) =>
    issues(bankTransactionCreateFormSchema, { ...base, operationDate }).filter(i =>
      i.startsWith('operationDate'),
    );

  it('сьогодні за Києвом — приймається; завтра — «не може бути в майбутньому»', () => {
    const today = kyivTodayYmd();
    const next = new Date(`${today}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const tomorrow = next.toISOString().slice(0, 10);
    expect(dateIssues(today)).toEqual([]);
    expect(dateIssues(tomorrow)).toEqual(['operationDate: v.bankTransaction.date.future']);
  });

  it('рік 0000 — не дата', () => {
    expect(dateIssues('0000-01-01')).toContain('operationDate: v.bankTransaction.date.required');
  });
});
