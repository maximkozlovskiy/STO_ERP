/**
 * Гроші постачальника через касу (BR-CASH-019): «оплата постачальнику» (видача) і «повернення
 * від постачальника» (внесення).
 *
 * Оплата — це документ, створений і проведений однією транзакцією
 * (`SupplierPaymentsService.createAndConfirm`, BR-SUPPAY-013): він сам пише рядок каси й зменшує
 * борг. Проведення не вдалося → відкочується все, чернетки не лишається. Повернення від
 * постачальника документа не має: рядок каси й проводка `SUPPLIER_PAYMENT_RETURN` в одній
 * транзакції, не більше нашого авансу постачальнику (BR-CASH-032).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  BOTH,
  CAT_EXPENSE,
  CAT_INCOME,
  CLIENT,
  ORG,
  PO,
  REG,
  SUPPLIER,
  USER,
  createOp,
  expectNothingMoved,
  makeDesk,
  validInput,
} from './cash-desk.spec-fixture';

describe('CashDeskService.create — оплата постачальнику (SUPPLIER_PAYMENT)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // guards: BR-CASH-019
  it.each([
    ['постачальник', SUPPLIER],
    ['«обидва»', BOTH],
  ])(
    'контрагент %s → оплата з джерелом «каса», готівкою, на суму з копійками',
    async (_n, supplierId) => {
      const h = makeDesk();
      await createOp(
        h,
        validInput('SUPPLIER_PAYMENT', {
          counterpartyId: supplierId,
          amount: 8640.35,
          notes: 'за фільтри',
        }),
      );

      expect(h.supplierPayments.createAndConfirm).toHaveBeenCalledTimes(1);
      const [orgId, dto, userId] = h.supplierPayments.createAndConfirm.mock.calls[0];
      expect(orgId).toBe(ORG);
      expect(dto).toMatchObject({
        supplierId,
        sourceType: 'CASH_REGISTER',
        cashRegisterId: REG,
        amount: 8640.35,
        method: 'cash',
        notes: 'за фільтри',
      });
      expect(userId).toBe(USER);
    },
  );

  // Рішення власника 2026-10-30 (TECH-DEBT (б) №34): створення й проведення — одна дія. Окремі
  // create → confirm → cancel лишали скасовану чернетку з витраченим номером.
  // guards: BR-CASH-019, BR-SUPPAY-013
  it('одна дія «створити й провести»: ні окремої чернетки, ні проведення, ні скасування', async () => {
    const h = makeDesk();
    const row = await createOp(h, validInput('SUPPLIER_PAYMENT'));

    expect(h.supplierPayments.createAndConfirm).toHaveBeenCalledTimes(1);
    expect(h.supplierPayments.create).not.toHaveBeenCalled();
    expect(h.supplierPayments.confirm).not.toHaveBeenCalled();
    expect(h.supplierPayments.cancel).not.toHaveBeenCalled();
    expect(row.documentNumber).toBe('ОПП-2026-000001');
  });

  // guards: BR-CASH-019, BR-CASH-001
  it('рядок каси й борг веде проведення оплати: CashDeskService сам не кличе ні касу, ні взаєморозрахунки', async () => {
    const h = makeDesk();
    await createOp(h, validInput('SUPPLIER_PAYMENT'));
    expect(h.cash.createOperation).not.toHaveBeenCalled();
    expect(h.settlements.createTransaction).not.toHaveBeenCalled();
    expect(h.payments.create).not.toHaveBeenCalled();
    expect(h.cashRows).toHaveLength(1);
    expect(h.cashRows[0]).toMatchObject({ documentType: 'SupplierPayment', documentId: 'sp-1' });
  });

  // Маршрут — під ключем ідемпотентності: кинуте читання ВЖЕ проведеної оплати знімає резервацію
  // ключа, і повтор заплатив би постачальнику вдруге. Тому відповідь — рядок, записаний проведенням.
  // guards: BR-CASH-019, BR-SUPPAY-013
  it('відповідь — рядок, записаний проведенням: журнал каси після коміту не перечитується', async () => {
    const h = makeDesk();
    h.tables.cashOperation.findFirst.mockRejectedValue(new Error("з'єднання з базою обірвалось"));
    const row = await createOp(h, validInput('SUPPLIER_PAYMENT'));
    expect(h.cashRows).toHaveLength(1);
    expect(row).toMatchObject({
      id: h.cashRows[0].id,
      documentType: 'SupplierPayment',
      documentNumber: 'ОПП-2026-000001',
    });
    expect(h.tables.cashOperation.findFirst).not.toHaveBeenCalled();
  });

  // guards: BR-CASH-019, BR-SUPPAY-013
  it('проведення не вдалося → помилка піднята, нічого не скасовують (нічого й не лишилось), каса не змінилась', async () => {
    const h = makeDesk();
    const boom = new BadRequestException('Недостатньо готівки в касі: доступно 10, потрібно 100');
    h.supplierPayments.createAndConfirm.mockRejectedValueOnce(boom);

    await expect(createOp(h, validInput('SUPPLIER_PAYMENT'))).rejects.toBe(boom);

    expect(h.supplierPayments.cancel).not.toHaveBeenCalled();
    expect(h.cashRows).toEqual([]);
    expect(h.settlementRows).toEqual([]);
  });

  // guards: BR-CASH-019
  it('клієнт в «оплаті постачальнику» → 400, оплату не створено', async () => {
    const h = makeDesk();
    const call = createOp(h, validInput('SUPPLIER_PAYMENT', { counterpartyId: CLIENT }));
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/постачальник/i);
    expectNothingMoved(h);
  });

  // guards: BR-CASH-019, BR-CASH-020
  it('замовлення-підстава йде в оплату як purchaseOrderId («сплачено» в замовленні веде проведення)', async () => {
    const h = makeDesk();
    await createOp(
      h,
      validInput('SUPPLIER_PAYMENT', { baseDocumentType: 'PurchaseOrder', baseDocumentId: PO }),
    );
    expect(h.supplierPayments.createAndConfirm.mock.calls[0][1]).toMatchObject({
      supplierId: SUPPLIER,
      purchaseOrderId: PO,
    });
  });

  // guards: BR-CASH-019
  it('без підстави purchaseOrderId в оплату не йде', async () => {
    const h = makeDesk();
    await createOp(h, validInput('SUPPLIER_PAYMENT'));
    expect(h.supplierPayments.createAndConfirm.mock.calls[0][1].purchaseOrderId ?? null).toBeNull();
  });

  // guards: BR-CASH-019, BR-CASH-020
  it('стаття й підстава, обрані в касі, доходять до оплати «додатками» касового рядка', async () => {
    const h = makeDesk();
    await createOp(
      h,
      validInput('SUPPLIER_PAYMENT', {
        expenseCategoryId: CAT_EXPENSE,
        baseDocumentType: 'PurchaseOrder',
        baseDocumentId: PO,
      }),
    );
    expect(h.supplierPayments.createAndConfirm.mock.calls[0][3]).toMatchObject({
      expenseCategoryId: CAT_EXPENSE,
      baseDocumentType: 'PurchaseOrder',
      baseDocumentId: PO,
    });
  });

  // Дата без часу проти мітки часу (урок Bug #798). `SupplierPayment.documentDate` — календарний
  // день (`YYYY-MM-DD`), касова операція датується «зараз». О 01:30 за Києвом 15 жовтня в UTC ще
  // 14-те: `new Date().toISOString().slice(0, 10)` дав би вчорашній день документа.
  // Порівнюється саме РЯДОК календарного дня за Києвом, а не мітка часу.
  // guards: BR-CASH-019
  it('якщо каса передає дату документа оплати — це київський календарний день, а не день UTC', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-14T22:30:00.000Z') });
    const h = makeDesk();
    await createOp(h, validInput('SUPPLIER_PAYMENT'));
    const documentDate: unknown = h.supplierPayments.createAndConfirm.mock.calls[0][1].documentDate;
    // Не передано — день ставить сам SupplierPaymentsService (його правила, його спеки).
    expect([undefined, '2026-10-15']).toContain(documentDate);
  });

  // guards: BR-CASH-019, BR-CASH-004
  it('одна копійка оплати доходить як 0.01', async () => {
    const h = makeDesk();
    await createOp(h, validInput('SUPPLIER_PAYMENT', { amount: 0.01 }));
    expect(h.supplierPayments.createAndConfirm.mock.calls[0][1].amount).toBe(0.01);
  });
});

// Рішення власника 2026-10-30 (TECH-DEBT (б) №37): повернути від постачальника можна не більше
// нашого авансу йому (`max(0, balance)` у базовій валюті).
describe('CashDeskService.create — повернення від постачальника не більше авансу (BR-CASH-032)', () => {
  // guards: BR-CASH-032
  it('понад аванс → 400 з доступною сумою; ні рядка каси, ні проводки', async () => {
    const h = makeDesk();
    h.refundAvailable.value = 99.99;

    await expect(
      createOp(h, validInput('SUPPLIER_REFUND_IN', { amount: 100 })),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('99.99') });

    expect(h.cashRows).toEqual([]);
    expect(h.settlementRows).toEqual([]);
  });

  // guards: BR-CASH-032
  it('рівно весь аванс проходить: рядок каси і SUPPLIER_PAYMENT_RETURN', async () => {
    const h = makeDesk();
    h.refundAvailable.value = 100;

    await createOp(h, validInput('SUPPLIER_REFUND_IN', { amount: 100 }));

    expect(h.cashRows).toHaveLength(1);
    expect(h.settlementRows).toEqual([
      expect.objectContaining({ type: 'SUPPLIER_PAYMENT_RETURN', amount: 100 }),
    ]);
  });

  // guards: BR-CASH-032
  it('аванс читається як сторона «постачальник» з блокуванням у транзакції, до рядка каси', async () => {
    const h = makeDesk();

    await createOp(h, validInput('SUPPLIER_REFUND_IN', { counterpartyId: BOTH }));

    expect(h.settlements.lockRefundAvailable).toHaveBeenCalledTimes(1);
    const [orgId, counterpartyId, side, client] = h.settlements.lockRefundAvailable.mock.calls[0];
    expect([orgId, counterpartyId, side]).toEqual([ORG, BOTH, 'supplier']);
    expect(h.isTx(client)).toBe(true);
    expect(h.settlements.lockRefundAvailable.mock.invocationCallOrder[0]).toBeLessThan(
      h.cash.createOperation.mock.invocationCallOrder[0],
    );
    expect(h.settlements.assertRefundWithin.mock.calls[0][1]).toBe('supplier');
  });
});

describe('CashDeskService.create — повернення від постачальника (SUPPLIER_REFUND_IN)', () => {
  // guards: BR-CASH-019
  it.each([
    ['постачальник', SUPPLIER],
    ['«обидва»', BOTH],
  ])(
    'контрагент %s → рядок каси (внесення) і SUPPLIER_PAYMENT_RETURN на ту саму суму, проводка посилається на рядок',
    async (_n, counterpartyId) => {
      const h = makeDesk();
      await createOp(
        h,
        validInput('SUPPLIER_REFUND_IN', { counterpartyId, amount: 2199.99, notes: 'переплата' }),
      );

      expect(h.cashRows).toHaveLength(1);
      expect(h.cashRows[0]).toMatchObject({
        orgId: ORG,
        cashRegisterId: REG,
        direction: 'IN',
        reason: 'SUPPLIER_REFUND_IN',
        amount: 2199.99,
        counterpartyId,
        createdBy: USER,
      });

      expect(h.settlementRows).toHaveLength(1);
      expect(h.settlementRows[0]).toMatchObject({
        orgId: ORG,
        counterpartyId,
        type: 'SUPPLIER_PAYMENT_RETURN',
        amount: 2199.99,
        documentType: 'CashOperation',
        documentId: h.cashRows[0].id,
      });
    },
  );

  // guards: BR-CASH-019, BR-CASH-011
  it('рядок каси і проводка йдуть ОДНІЄЮ транзакцією: обидва отримали той самий tx-клієнт', async () => {
    const h = makeDesk();
    await createOp(h, validInput('SUPPLIER_REFUND_IN'));

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    const cashTx = h.cash.createOperation.mock.calls[0][2];
    const settlementTx = h.settlements.createTransaction.mock.calls[0][2];
    expect(h.isTx(cashTx)).toBe(true);
    expect(settlementTx).toBe(cashTx);
    expect(h.cash.createOperation.mock.invocationCallOrder[0]).toBeLessThan(
      h.settlements.createTransaction.mock.invocationCallOrder[0],
    );
  });

  // guards: BR-CASH-019, BR-CASH-011
  it('проводка кинула → рядка каси немає: транзакція відкотилась, помилка піднята', async () => {
    const h = makeDesk();
    const boom = new Error('settlement account locked');
    h.settlements.createTransaction.mockRejectedValueOnce(boom);

    await expect(createOp(h, validInput('SUPPLIER_REFUND_IN', { amount: 320.1 }))).rejects.toBe(
      boom,
    );

    expect(h.cash.createOperation).toHaveBeenCalledTimes(1);
    expect(h.cashRows).toEqual([]);
    expect(h.settlementRows).toEqual([]);
  });

  // guards: BR-CASH-019
  it('клієнт у «поверненні від постачальника» → 400, нічого не проведено', async () => {
    const h = makeDesk();
    const call = createOp(h, validInput('SUPPLIER_REFUND_IN', { counterpartyId: CLIENT }));
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/постачальник/i);
    expectNothingMoved(h);
  });

  // guards: BR-CASH-019
  it('повернення не створює й не проводить оплату постачальнику («сплачено» в замовленні не змінюється)', async () => {
    const h = makeDesk();
    await createOp(
      h,
      validInput('SUPPLIER_REFUND_IN', {
        baseDocumentType: 'PurchaseOrder',
        baseDocumentId: PO,
        expenseCategoryId: CAT_INCOME,
      }),
    );
    expect(h.supplierPayments.createAndConfirm).not.toHaveBeenCalled();
    expect(h.payments.create).not.toHaveBeenCalled();
    expect(h.settlements.createTransaction).toHaveBeenCalledTimes(1);
    expect(h.cash.createOperation.mock.calls[0][1]).toMatchObject({
      expenseCategoryId: CAT_INCOME,
    });
  });

  // guards: BR-CASH-019, BR-CASH-004
  it('одна копійка повернення: і в касі, і в проводці 0.01', async () => {
    const h = makeDesk();
    await createOp(h, validInput('SUPPLIER_REFUND_IN', { amount: 0.01 }));
    expect(h.cashRows[0].amount).toBe(0.01);
    expect(h.settlementRows[0].amount).toBe(0.01);
  });
});
