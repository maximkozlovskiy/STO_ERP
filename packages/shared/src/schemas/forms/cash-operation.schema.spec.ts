/**
 * Таблиця приводів касової операції (`CASH_REASON_RULES`) і zod-схема ручної операції —
 * єдине джерело правил для web, api і тестів (BR-CASH-016, 020, 021).
 *
 * Очікування тут записані РУКАМИ з таблиці в дос'є (`docs/objects/cash.md`, план 2026-10-14),
 * а не виведені з `CASH_REASON_RULES`: інакше зміна рядка таблиці «сама себе підтверджувала б».
 * Перевірки схеми — навпаки, ідуть циклом по таблиці: новий привід без кейсу тут не лишається.
 */
import { describe, it, expect } from 'vitest';
import {
  CASH_REASON_RULES,
  CASH_REASON_VALUES,
  RECEPTIONIST_CASH_REASONS,
  cashOperationSchema,
  manualCashReasons,
  type CashReasonRule,
  type CashReasonValue,
} from './cash-operation.schema';

const CP = '33333333-3333-4333-8333-333333333333';
const EMP = '55555555-5555-4555-8555-555555555555';
const CAT = '66666666-6666-4666-8666-666666666666';
const DOC = '77777777-7777-4777-8777-777777777777';

/** Таблиця з дос'є, переписана рукою: привід → правило. */
const EXPECTED: Record<string, CashReasonRule> = {
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

const MANUAL = CASH_REASON_VALUES.filter(r => CASH_REASON_RULES[r].manual);
const WITH_COUNTERPARTY = MANUAL.filter(r => CASH_REASON_RULES[r].counterparty);
const WITH_EMPLOYEE = MANUAL.filter(r => CASH_REASON_RULES[r].employee);
const WITH_CATEGORY = MANUAL.filter(r => CASH_REASON_RULES[r].categoryRequired);
const WITH_BASE = MANUAL.filter(r => CASH_REASON_RULES[r].baseDocument);
const WITHOUT_BASE = MANUAL.filter(r => !CASH_REASON_RULES[r].baseDocument);

/** Мінімальний набір полів, з яким привід мусить пройти схему. */
function minimal(reason: CashReasonValue): Record<string, unknown> {
  const rule = CASH_REASON_RULES[reason];
  return {
    direction: rule.direction,
    reason,
    amount: '100',
    ...(rule.counterparty ? { counterpartyId: CP } : {}),
    ...(rule.employee ? { employeeId: EMP } : {}),
    ...(rule.categoryRequired ? { expenseCategoryId: CAT } : {}),
  };
}

/** Повідомлення всіх відмов схеми у вигляді `поле: ключ`. */
function issues(input: Record<string, unknown>): string[] {
  const res = cashOperationSchema.safeParse(input);
  return res.success ? [] : res.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
}

describe('CASH_REASON_RULES — таблиця приводів', () => {
  // guards: BR-CASH-016
  it('кожен привід зі списку значень має правило, і зайвих правил немає', () => {
    expect(Object.keys(CASH_REASON_RULES).sort()).toEqual([...CASH_REASON_VALUES].sort());
    expect(new Set(CASH_REASON_VALUES).size).toBe(CASH_REASON_VALUES.length);
  });

  // guards: BR-CASH-016, BR-CASH-020
  it.each(Object.keys(EXPECTED))(
    '%s: напрям, обов’язкові поля й тип підстави — як у таблиці дос’є',
    reason => {
      expect(CASH_REASON_RULES[reason as CashReasonValue]).toEqual(EXPECTED[reason]);
    },
  );

  // guards: BR-CASH-016
  it('таблиця дос’є і список значень покривають одні й ті самі приводи', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...CASH_REASON_VALUES].sort());
  });

  // guards: BR-CASH-016
  it('manualCashReasons: внесення — сім приводів у порядку таблиці', () => {
    expect(manualCashReasons('IN')).toEqual([
      'SALE_PAYMENT',
      'SUPPLIER_REFUND_IN',
      'ADVANCE_RETURN',
      'BANK_WITHDRAWAL',
      'OWNER_IN',
      'COLLECTION',
      'MANUAL_IN',
    ]);
  });

  // guards: BR-CASH-016
  it('manualCashReasons: видача — сім приводів у порядку таблиці, без «зарплати»', () => {
    expect(manualCashReasons('OUT')).toEqual([
      'REFUND',
      'SUPPLIER_PAYMENT',
      'ADVANCE_ISSUE',
      'BANK_DEPOSIT',
      'OWNER_OUT',
      'EXPENSE',
      'MANUAL_OUT',
    ]);
  });

  // guards: BR-CASH-016
  it('manualCashReasons не віддає PAYROLL для жодного напряму', () => {
    expect(manualCashReasons('IN')).not.toContain('PAYROLL');
    expect(manualCashReasons('OUT')).not.toContain('PAYROLL');
  });

  // guards: BR-CASH-021
  it('приймальня вносить у касу лише «оплату контрагента»', () => {
    expect([...RECEPTIONIST_CASH_REASONS]).toEqual(['SALE_PAYMENT']);
  });
});

describe('cashOperationSchema — привід, напрям і обов’язкові поля', () => {
  // guards: BR-CASH-016
  it.each(MANUAL)('%s: мінімальний набір полів проходить', reason => {
    expect(issues(minimal(reason))).toEqual([]);
  });

  // guards: BR-CASH-016
  it.each(MANUAL)('%s: протилежний напрям → відмова на полі reason', reason => {
    const opposite = CASH_REASON_RULES[reason].direction === 'IN' ? 'OUT' : 'IN';
    expect(issues({ ...minimal(reason), direction: opposite })).toEqual([
      'reason: v.cashOperation.reason.direction',
    ]);
  });

  // guards: BR-CASH-016
  it('PAYROLL вручну → відмова «привід ставить лише система», навіть із правильним напрямом', () => {
    expect(issues({ direction: 'OUT', reason: 'PAYROLL', amount: '100' })).toEqual([
      'reason: v.cashOperation.reason.autoOnly',
    ]);
  });

  // guards: BR-CASH-016
  it.each(WITH_COUNTERPARTY)('%s: без контрагента → відмова на полі counterpartyId', reason => {
    const { counterpartyId: _omit, ...rest } = minimal(reason);
    expect(issues(rest)).toEqual(['counterpartyId: v.cashOperation.counterparty.required']);
  });

  // guards: BR-CASH-016
  it.each(WITH_COUNTERPARTY)('%s: порожній рядок замість контрагента — теж відмова', reason => {
    expect(issues({ ...minimal(reason), counterpartyId: '' })).toEqual([
      'counterpartyId: v.cashOperation.counterparty.required',
    ]);
  });

  // guards: BR-CASH-016
  it.each(WITH_EMPLOYEE)('%s: без працівника → відмова на полі employeeId', reason => {
    const { employeeId: _omit, ...rest } = minimal(reason);
    expect(issues(rest)).toEqual(['employeeId: v.cashOperation.employee.required']);
  });

  // guards: BR-CASH-016
  it.each(WITH_CATEGORY)('%s: без статті → відмова на полі expenseCategoryId', reason => {
    const { expenseCategoryId: _omit, ...rest } = minimal(reason);
    expect(issues(rest)).toEqual(['expenseCategoryId: v.cashOperation.category.required']);
  });

  // guards: BR-CASH-016
  it('списки «з контрагентом / з працівником / зі статтею» не порожні — цикли вище справді щось перевіряють', () => {
    expect(WITH_COUNTERPARTY).toEqual([
      'SALE_PAYMENT',
      'SUPPLIER_REFUND_IN',
      'REFUND',
      'SUPPLIER_PAYMENT',
    ]);
    expect(WITH_EMPLOYEE).toEqual(['ADVANCE_RETURN', 'ADVANCE_ISSUE']);
    expect(WITH_CATEGORY).toEqual(['EXPENSE']);
  });

  // guards: BR-CASH-016
  it('невідомий привід і невідомий напрям → відмова', () => {
    expect(issues({ direction: 'IN', reason: 'BOGUS', amount: '100' })).toEqual([
      'reason: v.cashOperation.reason.required',
    ]);
    expect(issues({ direction: 'SIDEWAYS', reason: 'MANUAL_IN', amount: '100' })).toEqual([
      'direction: v.cashOperation.direction.required',
    ]);
  });
});

describe('cashOperationSchema — документ-підстава', () => {
  // guards: BR-CASH-020
  it.each(WITH_BASE)('%s: підстава дозволеного типу з id проходить', reason => {
    expect(
      issues({
        ...minimal(reason),
        baseDocumentType: CASH_REASON_RULES[reason].baseDocument,
        baseDocumentId: DOC,
      }),
    ).toEqual([]);
  });

  // guards: BR-CASH-020
  it.each(WITH_BASE)('%s: тип підстави без id → «вказано неповністю»', reason => {
    expect(
      issues({ ...minimal(reason), baseDocumentType: CASH_REASON_RULES[reason].baseDocument }),
    ).toEqual(['baseDocumentId: v.cashOperation.baseDocument.incomplete']);
  });

  // guards: BR-CASH-020
  it.each(WITH_BASE)('%s: id підстави без типу → «вказано неповністю»', reason => {
    expect(issues({ ...minimal(reason), baseDocumentId: DOC })).toEqual([
      'baseDocumentId: v.cashOperation.baseDocument.incomplete',
    ]);
  });

  // guards: BR-CASH-020
  it.each(WITH_BASE)('%s: підстава не того типу → «не може бути підставою»', reason => {
    const wrong =
      CASH_REASON_RULES[reason].baseDocument === 'WorkOrder' ? 'PurchaseOrder' : 'WorkOrder';
    expect(issues({ ...minimal(reason), baseDocumentType: wrong, baseDocumentId: DOC })).toEqual([
      'baseDocumentId: v.cashOperation.baseDocument.notAllowed',
    ]);
  });

  // guards: BR-CASH-020
  it.each(WITHOUT_BASE)('%s: привід без підстави в таблиці не приймає жодної', reason => {
    expect(
      issues({ ...minimal(reason), baseDocumentType: 'WorkOrder', baseDocumentId: DOC }),
    ).toEqual(['baseDocumentId: v.cashOperation.baseDocument.notAllowed']);
  });

  // guards: BR-CASH-020
  it('тип підстави поза переліком (рахунок) → відмова', () => {
    expect(
      cashOperationSchema.safeParse({
        ...minimal('SALE_PAYMENT'),
        baseDocumentType: 'Invoice',
        baseDocumentId: DOC,
      }).success,
    ).toBe(false);
  });

  // guards: BR-CASH-020
  it('порожні рядки й null у полях підстави = підстави немає', () => {
    const res = cashOperationSchema.safeParse({
      ...minimal('SALE_PAYMENT'),
      baseDocumentType: '',
      baseDocumentId: null,
    });
    expect(res.success).toBe(true);
    expect(res.data?.baseDocumentType).toBeUndefined();
    expect(res.data?.baseDocumentId).toBeUndefined();
  });
});

describe('cashOperationSchema — сума й примітка', () => {
  // guards: BR-CASH-004
  it.each([
    ['1250,75', 1250.75],
    ['1250.75', 1250.75],
    ['0,01', 0.01],
    [99.99, 99.99],
  ])('сума %s розбирається як %s (копійки, українська кома)', (raw, parsed) => {
    const res = cashOperationSchema.safeParse({ ...minimal('MANUAL_IN'), amount: raw });
    expect(res.success).toBe(true);
    expect(res.data?.amount).toBe(parsed);
  });

  // guards: BR-CASH-004
  it.each([['0'], ['0,004'], ['-5'], [''], ['abc']])('сума «%s» → відмова', raw => {
    const res = cashOperationSchema.safeParse({ ...minimal('MANUAL_IN'), amount: raw });
    expect(res.success).toBe(false);
    expect(res.error?.issues.map(i => i.path.join('.'))).toEqual(['amount']);
  });

  // guards: BR-CASH-016
  it('примітка: 500 символів проходить, 501 — ні; порожня стає undefined', () => {
    expect(issues({ ...minimal('MANUAL_IN'), notes: 'я'.repeat(500) })).toEqual([]);
    expect(issues({ ...minimal('MANUAL_IN'), notes: 'я'.repeat(501) })).toEqual([
      'notes: v.cashOperation.notes.max',
    ]);
    const res = cashOperationSchema.safeParse({ ...minimal('MANUAL_IN'), notes: '' });
    expect(res.data?.notes).toBeUndefined();
  });
});
