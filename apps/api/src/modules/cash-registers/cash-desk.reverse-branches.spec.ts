/**
 * Сторно за приводом оригіналу — що каса-диригент відкочує, крім рядка каси (BR-CASH-024, 025):
 *
 * | привід оригіналу                         | відкат                                                  |
 * | ---------------------------------------- | ------------------------------------------------------- |
 * | оплата контрагента (`Payment`)           | `PaymentsService.reverse` — проводку пише сервіс оплат  |
 * | оплата постачальнику (`SupplierPayment`) | `SupplierPaymentsService.reverse` — так само            |
 * | повернення клієнту (`REFUND`)            | проводка `REFUND_OUT_CANCEL` (−1) з курсом оригіналу    |
 * | повернення від постачальника             | проводка `SUPPLIER_PAYMENT_RETURN_CANCEL` (+1)          |
 * | решта ручних приводів                    | лише рядок каси                                          |
 *
 * Наслідки всередині сервісів оплат — `../payments/payments.reverse.spec.ts` і
 * `../supplier-payments/supplier-payments.reverse.spec.ts`. Тут — що й кому каса передає.
 *
 * Контракт (план 2026-10-14):
 *   PaymentsService.reverse(orgId, paymentId, { cashOperationId, reason, userId }, tx)
 *   SupplierPaymentsService.reverse(orgId, id, { cashOperationId, reason, userId }, tx)
 *   проводка сторно повернення: documentType 'CashOperation', documentId = id рядка сторно,
 *   conversion — з проводки оригіналу.
 */
import { describe, it, expect } from 'vitest';
import {
  CAT_EXPENSE,
  CLIENT,
  EMP,
  ORG,
  PO,
  SUPPLIER,
  USER,
  WO,
  makeDesk,
  newCashRows,
  reverseOp,
  seedOperation,
  type Desk,
} from './cash-desk.spec-fixture';
import type { MemRow } from '../cash/cash.spec-fixture';

const PAY = 'p1000001-0000-4000-8000-000000000001';
const SP = 's1000001-0000-4000-8000-000000000001';

/** Рядок сторно, який записав кейс (рівно один). */
function stornoRow(h: Desk, seeded: number): MemRow {
  const rows = newCashRows(h, seeded);
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** Проводка оригіналу повернення — з курсом, який сторно мусить дзеркалити. */
function seedSettlement(h: Desk, row: MemRow): void {
  h.tables.settlementTransaction.rows.push({
    id: `st-${h.tables.settlementTransaction.rows.length + 1}`,
    orgId: ORG,
    settlementAccountId: 'acc-1',
    currencyId: null,
    createdAt: new Date('2026-09-01T08:00:00.000Z'),
    ...row,
  });
}

describe('CashDeskService.reverse — оплата контрагента (SALE_PAYMENT, документ Payment)', () => {
  const seedPayment = (h: Desk, over: MemRow = {}) => {
    h.tables.payment.rows.push({
      id: PAY,
      orgId: ORG,
      counterpartyId: CLIENT,
      workOrderId: WO,
      invoiceId: null,
      amount: 1250.75,
      currencyId: null,
      amountBase: 1250.75,
      rateUsed: 1,
      fiscalStatus: null,
      reversedAt: null,
      reversalCashOperationId: null,
    });
    return seedOperation(h, {
      direction: 'IN',
      reason: 'SALE_PAYMENT',
      amount: 1250.75,
      counterpartyId: CLIENT,
      documentType: 'Payment',
      documentId: PAY,
      baseDocumentType: 'WorkOrder',
      baseDocumentId: WO,
      ...over,
    });
  };

  // guards: BR-CASH-024
  it('відкат передається сервісу оплат: id оплати — з documentId оригіналу, cashOperationId — рядок сторно, причина й автор', async () => {
    const h = makeDesk();
    const orig = seedPayment(h);
    const seeded = h.cashRows.length;

    await reverseOp(h, orig.id as string, 'клієнт заплатив карткою, а не готівкою');

    const storno = stornoRow(h, seeded);
    expect(storno).toMatchObject({
      direction: 'OUT',
      reason: 'SALE_PAYMENT',
      counterpartyId: CLIENT,
      reversalOfId: orig.id,
    });
    expect(h.payments.reverse).toHaveBeenCalledTimes(1);
    const [orgId, paymentId, ctx] = h.payments.reverse.mock.calls[0] as [string, string, MemRow];
    expect(orgId).toBe(ORG);
    expect(paymentId).toBe(PAY);
    expect(ctx).toMatchObject({
      cashOperationId: storno.id,
      reason: 'клієнт заплатив карткою, а не готівкою',
      userId: USER,
    });
  });

  // guards: BR-CASH-024
  it('відкат оплати йде в ТІЙ САМІЙ транзакції, що й рядок сторно, і ПІСЛЯ нього (потрібен id рядка)', async () => {
    const h = makeDesk();
    const orig = seedPayment(h);
    await reverseOp(h, orig.id as string);
    const cashTx = h.cash.createOperation.mock.calls[0][2];
    const payTx = h.payments.reverse.mock.calls[0][3];
    expect(h.isTx(cashTx)).toBe(true);
    expect(payTx).toBe(cashTx);
    expect(h.cash.createOperation.mock.invocationCallOrder[0]).toBeLessThan(
      h.payments.reverse.mock.invocationCallOrder[0],
    );
  });

  // Проводку PAYMENT_CANCEL пише сервіс оплат. Якби каса писала й свою — борг повернувся б двічі.
  // guards: BR-CASH-024
  it('каса САМА проводок не пише і оплату постачальнику не чіпає', async () => {
    const h = makeDesk();
    const orig = seedPayment(h);
    await reverseOp(h, orig.id as string);
    expect(h.settlements.createTransaction).not.toHaveBeenCalled();
    expect(h.supplierPayments.reverse).not.toHaveBeenCalled();
    expect(h.payments.create).not.toHaveBeenCalled();
  });

  // guards: BR-CASH-024
  it('аванс (оплата без підстави) — той самий шлях через сервіс оплат', async () => {
    const h = makeDesk();
    const orig = seedPayment(h, { baseDocumentType: null, baseDocumentId: null });
    await reverseOp(h, orig.id as string);
    expect(h.payments.reverse).toHaveBeenCalledTimes(1);
    expect(h.payments.reverse.mock.calls[0][1]).toBe(PAY);
  });
});

describe('CashDeskService.reverse — оплата постачальнику (SUPPLIER_PAYMENT, документ SupplierPayment)', () => {
  const seedSupplierPayment = (h: Desk) => {
    h.tables.supplierPayment.rows.push({
      id: SP,
      orgId: ORG,
      supplierId: SUPPLIER,
      purchaseOrderId: PO,
      status: 'CONFIRMED',
      amount: 4200,
      currencyId: 'uah-id',
      totalAmountBase: 4200,
      rateUsed: 1,
      deletedAt: null,
    });
    return seedOperation(h, {
      direction: 'OUT',
      reason: 'SUPPLIER_PAYMENT',
      amount: 4200,
      amountBase: 4200,
      counterpartyId: SUPPLIER,
      documentType: 'SupplierPayment',
      documentId: SP,
      baseDocumentType: 'PurchaseOrder',
      baseDocumentId: PO,
    });
  };

  // guards: BR-CASH-024
  it('відкат передається сервісу оплат постачальникам: id — з documentId оригіналу; сторно — внесення', async () => {
    const h = makeDesk();
    const orig = seedSupplierPayment(h);
    const seeded = h.cashRows.length;

    await reverseOp(h, orig.id as string, 'не той постачальник');

    const storno = stornoRow(h, seeded);
    expect(storno).toMatchObject({
      direction: 'IN',
      reason: 'SUPPLIER_PAYMENT',
      counterpartyId: SUPPLIER,
      baseDocumentType: 'PurchaseOrder',
      baseDocumentId: PO,
    });
    expect(h.supplierPayments.reverse).toHaveBeenCalledTimes(1);
    const [orgId, id, ctx, tx] = h.supplierPayments.reverse.mock.calls[0] as [
      string,
      string,
      MemRow,
      unknown,
    ];
    expect(orgId).toBe(ORG);
    expect(id).toBe(SP);
    expect(ctx).toMatchObject({
      cashOperationId: storno.id,
      reason: 'не той постачальник',
      userId: USER,
    });
    expect(tx).toBe(h.cash.createOperation.mock.calls[0][2]);
  });

  // guards: BR-CASH-024
  it('каса сама проводок не пише й оплату клієнта не чіпає', async () => {
    const h = makeDesk();
    const orig = seedSupplierPayment(h);
    await reverseOp(h, orig.id as string);
    expect(h.settlements.createTransaction).not.toHaveBeenCalled();
    expect(h.payments.reverse).not.toHaveBeenCalled();
    expect(h.supplierPayments.confirm).not.toHaveBeenCalled();
    expect(h.supplierPayments.cancel).not.toHaveBeenCalled();
  });
});

describe('CashDeskService.reverse — повернення клієнту (REFUND)', () => {
  const seedRefund = (h: Desk, amount: number, amountBase: number, rateUsed: number) => {
    const orig = seedOperation(h, {
      direction: 'OUT',
      reason: 'REFUND',
      amount,
      amountBase,
      rateUsed,
      counterpartyId: CLIENT,
    });
    seedSettlement(h, {
      type: 'REFUND_OUT',
      amount,
      amountBase,
      rateUsed,
      documentType: 'CashOperation',
      documentId: orig.id,
    });
    return orig;
  };

  // guards: BR-CASH-025
  it('сторно — внесення; проводка REFUND_OUT_CANCEL на ту саму суму, посилається на РЯДОК СТОРНО', async () => {
    const h = makeDesk();
    const orig = seedRefund(h, 780.4, 780.4, 1);
    const seeded = h.cashRows.length;

    await reverseOp(h, orig.id as string);

    const storno = stornoRow(h, seeded);
    expect(storno).toMatchObject({ direction: 'IN', reason: 'REFUND', counterpartyId: CLIENT });
    expect(h.settlementRows).toHaveLength(1);
    expect(h.settlementRows[0]).toMatchObject({
      orgId: ORG,
      counterpartyId: CLIENT,
      type: 'REFUND_OUT_CANCEL',
      documentType: 'CashOperation',
      documentId: storno.id,
    });
    expect(Number(h.settlementRows[0].amount)).toBe(780.4);
  });

  // Валютна каса: повернення провело борг за курсом свого дня; сторно мусить повернути РІВНО ту
  // базову суму, інакше баланс контрагента після «повернення + сторно» не повернеться до початкового.
  // guards: BR-CASH-025
  it('валютне повернення → проводка сторно несе conversion ПРОВОДКИ ОРИГІНАЛУ', async () => {
    const h = makeDesk();
    h.tables.cashRegister.rows[0].currencyId = 'usd-id';
    const orig = seedRefund(h, 18.8, 779.64, 41.47);

    await reverseOp(h, orig.id as string);

    const conversion = h.settlementRows[0]?.conversion as
      { rateUsed: unknown; amountBase: unknown } | undefined;
    expect(conversion).toBeDefined();
    expect(Number(conversion?.rateUsed)).toBe(41.47);
    expect(Number(conversion?.amountBase)).toBe(779.64);
    expect(Number(h.settlementRows[0].amount)).toBe(18.8);
  });

  // guards: BR-CASH-025
  it('рядок каси і проводка — одна транзакція: проводка отримала той самий tx і пішла ПІСЛЯ рядка', async () => {
    const h = makeDesk();
    const orig = seedRefund(h, 100, 100, 1);
    await reverseOp(h, orig.id as string);
    const cashTx = h.cash.createOperation.mock.calls[0][2];
    expect(h.isTx(cashTx)).toBe(true);
    expect(h.settlements.createTransaction.mock.calls[0][2]).toBe(cashTx);
    expect(h.cash.createOperation.mock.invocationCallOrder[0]).toBeLessThan(
      h.settlements.createTransaction.mock.invocationCallOrder[0],
    );
  });

  // Рішення власника 2026-10-14: повернення рухає лише баланс контрагента — і сторно теж.
  // guards: BR-CASH-025
  it('сторно повернення не чіпає оплат («сплачено» не змінюється)', async () => {
    const h = makeDesk();
    const orig = seedRefund(h, 100, 100, 1);
    await reverseOp(h, orig.id as string);
    expect(h.payments.reverse).not.toHaveBeenCalled();
    expect(h.supplierPayments.reverse).not.toHaveBeenCalled();
    expect(h.settlementRows.map(r => r.type)).toEqual(['REFUND_OUT_CANCEL']);
  });
});

describe('CashDeskService.reverse — повернення від постачальника (SUPPLIER_REFUND_IN)', () => {
  // guards: BR-CASH-025
  it('сторно — видача; проводка SUPPLIER_PAYMENT_RETURN_CANCEL з курсом оригіналу, посилається на рядок сторно', async () => {
    const h = makeDesk();
    h.tables.cashRegister.rows[0].currencyId = 'eur-id';
    const orig = seedOperation(h, {
      direction: 'IN',
      reason: 'SUPPLIER_REFUND_IN',
      amount: 250.55,
      amountBase: 11905.13,
      rateUsed: 47.515,
      counterpartyId: SUPPLIER,
      baseDocumentType: 'PurchaseOrder',
      baseDocumentId: PO,
    });
    seedSettlement(h, {
      type: 'SUPPLIER_PAYMENT_RETURN',
      amount: 250.55,
      amountBase: 11905.13,
      rateUsed: 47.515,
      documentType: 'CashOperation',
      documentId: orig.id,
    });
    const seeded = h.cashRows.length;

    await reverseOp(h, orig.id as string);

    const storno = stornoRow(h, seeded);
    expect(storno).toMatchObject({
      direction: 'OUT',
      reason: 'SUPPLIER_REFUND_IN',
      counterpartyId: SUPPLIER,
    });
    expect(h.settlementRows).toHaveLength(1);
    const posting = h.settlementRows[0];
    expect(posting).toMatchObject({
      orgId: ORG,
      counterpartyId: SUPPLIER,
      type: 'SUPPLIER_PAYMENT_RETURN_CANCEL',
      documentType: 'CashOperation',
      documentId: storno.id,
    });
    expect(Number(posting.amount)).toBe(250.55);
    const conversion = posting.conversion as { rateUsed: unknown; amountBase: unknown };
    expect(Number(conversion.rateUsed)).toBe(47.515);
    expect(Number(conversion.amountBase)).toBe(11905.13);
    expect(h.supplierPayments.reverse).not.toHaveBeenCalled();
  });
});

describe('CashDeskService.reverse — прості ручні приводи: лише рядок каси', () => {
  // guards: BR-CASH-025
  it.each<[string, MemRow]>([
    ['MANUAL_IN', { direction: 'IN' }],
    ['MANUAL_OUT', { direction: 'OUT' }],
    ['OWNER_IN', { direction: 'IN' }],
    ['OWNER_OUT', { direction: 'OUT' }],
    ['COLLECTION', { direction: 'OUT' }],
    ['EXPENSE', { direction: 'OUT', expenseCategoryId: CAT_EXPENSE }],
    ['ADVANCE_ISSUE', { direction: 'OUT', employeeId: EMP }],
    ['ADVANCE_RETURN', { direction: 'IN', employeeId: EMP }],
    ['BANK_DEPOSIT', { direction: 'OUT' }],
    ['BANK_WITHDRAWAL', { direction: 'IN' }],
  ])(
    '%s → один рядок протилежного напряму, без проводок і без відкату оплат',
    async (reason, over) => {
      const h = makeDesk();
      const orig = seedOperation(h, { reason, ...over });
      const seeded = h.cashRows.length;

      await reverseOp(h, orig.id as string);

      const storno = stornoRow(h, seeded);
      expect(storno.direction).toBe(over.direction === 'IN' ? 'OUT' : 'IN');
      expect(storno.reason).toBe(reason);
      expect(h.settlements.createTransaction).not.toHaveBeenCalled();
      expect(h.settlementRows).toEqual([]);
      expect(h.payments.reverse).not.toHaveBeenCalled();
      expect(h.supplierPayments.reverse).not.toHaveBeenCalled();
    },
  );
});
