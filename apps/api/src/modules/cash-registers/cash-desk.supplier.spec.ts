/**
 * Гроші постачальника через касу (BR-CASH-019): «оплата постачальнику» (видача) і «повернення
 * від постачальника» (внесення).
 *
 * Оплата — це документ: чернетка (`SupplierPaymentsService.create`) і одразу проведення
 * (`confirm`), яке саме пише рядок каси й зменшує борг. Проведення не вдалося → чернетка
 * скасовується (`cancel`), каса й борг не змінюються. Повернення від постачальника документа не
 * має: рядок каси й проводка `SUPPLIER_PAYMENT_RETURN` в одній транзакції.
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
    'контрагент %s → чернетка оплати з джерелом «каса», готівкою, на суму з копійками',
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

      expect(h.supplierPayments.create).toHaveBeenCalledTimes(1);
      const [orgId, dto, userId] = h.supplierPayments.create.mock.calls[0];
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

  // guards: BR-CASH-019
  it('чернетку одразу проведено: confirm ПІСЛЯ create, з id чернетки й автором; cancel не викликано', async () => {
    const h = makeDesk();
    await createOp(h, validInput('SUPPLIER_PAYMENT'));

    expect(h.supplierPayments.confirm).toHaveBeenCalledTimes(1);
    const [orgId, id, userId] = h.supplierPayments.confirm.mock.calls[0];
    expect([orgId, id, userId]).toEqual([ORG, 'sp-1', USER]);
    expect(h.supplierPayments.create.mock.invocationCallOrder[0]).toBeLessThan(
      h.supplierPayments.confirm.mock.invocationCallOrder[0],
    );
    expect(h.supplierPayments.cancel).not.toHaveBeenCalled();
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

  // guards: BR-CASH-019
  it('проведення не вдалося → чернетку скасовано, помилка піднята, каса не змінилась', async () => {
    const h = makeDesk();
    const boom = new BadRequestException('Недостатньо готівки в касі: доступно 10, потрібно 100');
    h.supplierPayments.confirm.mockRejectedValueOnce(boom);

    await expect(createOp(h, validInput('SUPPLIER_PAYMENT'))).rejects.toBe(boom);

    expect(h.supplierPayments.cancel).toHaveBeenCalledTimes(1);
    expect(h.supplierPayments.cancel.mock.calls[0].slice(0, 2)).toEqual([ORG, 'sp-1']);
    expect(h.cashRows).toEqual([]);
    expect(h.settlementRows).toEqual([]);
  });

  // guards: BR-CASH-019
  it('чернетку створити не вдалося → ні проведення, ні скасування; помилка піднята', async () => {
    const h = makeDesk();
    const boom = new BadRequestException('Постачальника не знайдено');
    h.supplierPayments.create.mockRejectedValueOnce(boom);

    await expect(createOp(h, validInput('SUPPLIER_PAYMENT'))).rejects.toBe(boom);

    expect(h.supplierPayments.confirm).not.toHaveBeenCalled();
    expect(h.supplierPayments.cancel).not.toHaveBeenCalled();
    expect(h.cashRows).toEqual([]);
  });

  // guards: BR-CASH-019
  it('клієнт в «оплаті постачальнику» → 400, чернетку не створено', async () => {
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
    expect(h.supplierPayments.create.mock.calls[0][1]).toMatchObject({
      supplierId: SUPPLIER,
      purchaseOrderId: PO,
    });
  });

  // guards: BR-CASH-019
  it('без підстави purchaseOrderId в оплату не йде', async () => {
    const h = makeDesk();
    await createOp(h, validInput('SUPPLIER_PAYMENT'));
    expect(h.supplierPayments.create.mock.calls[0][1].purchaseOrderId ?? null).toBeNull();
  });

  // ПОТРЕБУЄ ЗВІРКИ після злиття: контракт каже, що «додатки касового рядка» (стаття, підстава)
  // отримує `SupplierPaymentsService.confirm`; у якому аргументі — не каже. Кейс приймає їх у
  // будь-якому аргументі create або confirm.
  // guards: BR-CASH-019, BR-CASH-020
  it('стаття й підстава, обрані в касі, доходять до оплати «додатками» (у create або confirm)', async () => {
    const h = makeDesk();
    await createOp(
      h,
      validInput('SUPPLIER_PAYMENT', {
        expenseCategoryId: CAT_EXPENSE,
        baseDocumentType: 'PurchaseOrder',
        baseDocumentId: PO,
      }),
    );
    const args: unknown[] = [
      ...h.supplierPayments.create.mock.calls[0],
      ...h.supplierPayments.confirm.mock.calls[0],
    ];
    expect(args).toEqual(
      expect.arrayContaining([expect.objectContaining({ expenseCategoryId: CAT_EXPENSE })]),
    );
    expect(args).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ baseDocumentType: 'PurchaseOrder', baseDocumentId: PO }),
      ]),
    );
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
    const documentDate: unknown = h.supplierPayments.create.mock.calls[0][1].documentDate;
    // Не передано — день ставить сам SupplierPaymentsService (його правила, його спеки).
    expect([undefined, '2026-10-15']).toContain(documentDate);
  });

  // guards: BR-CASH-019, BR-CASH-004
  it('одна копійка оплати доходить як 0.01', async () => {
    const h = makeDesk();
    await createOp(h, validInput('SUPPLIER_PAYMENT', { amount: 0.01 }));
    expect(h.supplierPayments.create.mock.calls[0][1].amount).toBe(0.01);
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
    expect(h.supplierPayments.create).not.toHaveBeenCalled();
    expect(h.supplierPayments.confirm).not.toHaveBeenCalled();
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
