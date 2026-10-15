/**
 * Гроші клієнта через касу: «оплата контрагента» (BR-CASH-017) і «повернення клієнту»
 * (BR-CASH-018).
 *
 * Оплата НЕ пише рядок каси сама — вона створює оплату клієнта (`PaymentsService.create`), а та
 * вже зменшує борг, пробиває чек, нараховує бонуси й пише ЄДИНИЙ рядок каси. Повернення —
 * навпаки: рядок каси й проводка `REFUND_OUT` в одній транзакції, без документа оплати.
 */
import { describe, it, expect } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BOTH,
  CAT_INCOME,
  CLIENT,
  ORG,
  OTHER_ORG,
  REG,
  SUPPLIER,
  USER,
  WO,
  createOp,
  expectNothingMoved,
  makeDesk,
  validInput,
  type Desk,
} from './cash-desk.spec-fixture';
import type { MemRow } from '../cash/cash.spec-fixture';

/** Аргументи єдиного виклику PaymentsService.create: (orgId, dto, …решта). */
function paymentCall(h: Desk) {
  expect(h.payments.create).toHaveBeenCalledTimes(1);
  const [orgId, dto, ...rest] = h.payments.create.mock.calls[0];
  return { orgId, dto, rest, all: h.payments.create.mock.calls[0] as unknown[] };
}

const setWorkOrderStatus = (h: Desk, status: string): void => {
  const wo = h.tables.workOrder.rows.find(r => r.id === WO);
  if (!wo) throw new Error('у фікстурі немає наряду WO');
  wo.status = status;
};

describe('CashDeskService.create — оплата контрагента (SALE_PAYMENT)', () => {
  // guards: BR-CASH-017
  it.each([
    ['клієнт', CLIENT],
    ['«обидва»', BOTH],
  ])(
    'контрагент %s → оплата клієнта з джерелом «каса», готівкою, на суму з копійками',
    async (_n, counterpartyId) => {
      const h = makeDesk();
      await createOp(
        h,
        validInput('SALE_PAYMENT', { counterpartyId, amount: 1250.75, notes: 'аванс за ремонт' }),
      );

      const { orgId, dto, rest } = paymentCall(h);
      expect(orgId).toBe(ORG);
      expect(dto).toMatchObject({
        counterpartyId,
        amount: 1250.75,
        method: 'cash',
        sourceType: 'CASH_REGISTER',
        cashRegisterId: REG,
        notes: 'аванс за ремонт',
      });
      // Автор оплати — користувач запиту (третій аргумент PaymentsService.create).
      expect(rest[0]).toBe(USER);
    },
  );

  // guards: BR-CASH-017, BR-CASH-001
  it('рядок каси пише сама оплата: CashDeskService не кличе createOperation і не чіпає взаєморозрахунки', async () => {
    const h = makeDesk();
    await createOp(h, validInput('SALE_PAYMENT'));
    expect(h.payments.create).toHaveBeenCalledTimes(1);
    expect(h.cash.createOperation).not.toHaveBeenCalled();
    expect(h.settlements.createTransaction).not.toHaveBeenCalled();
    expect(h.supplierPayments.create).not.toHaveBeenCalled();
    // У журналі — рівно один рядок, і він від оплати.
    expect(h.cashRows).toHaveLength(1);
    expect(h.cashRows[0]).toMatchObject({ documentType: 'Payment' });
  });

  // guards: BR-CASH-017
  it('постачальник в «оплаті контрагента» → 400, оплату не створено', async () => {
    const h = makeDesk();
    const call = createOp(h, validInput('SALE_PAYMENT', { counterpartyId: SUPPLIER }));
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/постачальник/i);
    expectNothingMoved(h);
  });

  // guards: BR-CASH-017
  it('без підстави: наряд в оплату не передається', async () => {
    const h = makeDesk();
    await createOp(h, validInput('SALE_PAYMENT'));
    expect(paymentCall(h).dto.workOrderId ?? null).toBeNull();
  });

  // BR-CASH-017 (рішення власника 2026-10-15): підстава-наряд — завжди оплата за нарядом; аванс чи
  // оплата (тип проводки) визначає сам PaymentsService за статусом наряду (BR-PAY-020).
  // guards: BR-CASH-017
  it.each(['DRAFT', 'ESTIMATE', 'APPROVED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'INVOICED'])(
    'наряд у статусі %s → оплата йде ЗА НАРЯДОМ: workOrderId є, settlementType із каси немає',
    async status => {
      const h = makeDesk();
      setWorkOrderStatus(h, status);
      await createOp(
        h,
        validInput('SALE_PAYMENT', {
          amount: 3400.5,
          baseDocumentType: 'WorkOrder',
          baseDocumentId: WO,
        }),
      );
      const { dto } = paymentCall(h);
      expect(dto).toMatchObject({ counterpartyId: CLIENT, amount: 3400.5, workOrderId: WO });
      expect(dto.settlementType).toBeUndefined();
    },
  );

  // guards: BR-CASH-026
  it.each([
    ['CANCELLED', 'Скасовано'],
    ['PAID', 'Оплачено'],
    ['ARCHIVED', 'Архів'],
  ])(
    'підстава — наряд у статусі %s → 400 «Наряд у статусі «%s» не приймає оплату», нічого не пишеться',
    async (status, label) => {
      const h = makeDesk();
      setWorkOrderStatus(h, status);
      const call = createOp(
        h,
        validInput('SALE_PAYMENT', { baseDocumentType: 'WorkOrder', baseDocumentId: WO }),
      );
      await expect(call).rejects.toThrow(BadRequestException);
      await expect(call).rejects.toThrow(`Наряд у статусі «${label}» не приймає оплату`);
      expect(h.payments.create).not.toHaveBeenCalled();
      expectNothingMoved(h);
    },
  );

  // guards: BR-CASH-017, BR-CASH-020
  it.each(['INVOICED', 'IN_PROGRESS'])(
    'наряд (%s) лишається підставою рядка каси: baseDocument* доходить до оплати «додатками»',
    async status => {
      const h = makeDesk();
      setWorkOrderStatus(h, status);
      await createOp(
        h,
        validInput('SALE_PAYMENT', { baseDocumentType: 'WorkOrder', baseDocumentId: WO }),
      );
      // Де саме лежать «додатки касового рядка» (у dto чи окремим аргументом) — деталь
      // реалізації; правило вимагає лише, щоб оплата їх отримала.
      expect(paymentCall(h).all).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ baseDocumentType: 'WorkOrder', baseDocumentId: WO }),
        ]),
      );
    },
  );

  // guards: BR-CASH-017
  it('стаття, обрана в касі, доходить до оплати «додатками» (єдиний рядок каси несе її одразу)', async () => {
    const h = makeDesk();
    await createOp(h, validInput('SALE_PAYMENT', { expenseCategoryId: CAT_INCOME }));
    expect(paymentCall(h).all).toEqual(
      expect.arrayContaining([expect.objectContaining({ expenseCategoryId: CAT_INCOME })]),
    );
  });

  // guards: BR-CASH-017
  it('оплата не вдалась → помилка піднята як є, у касі й боргу нічого', async () => {
    const h = makeDesk();
    const boom = new BadRequestException(
      'Для фіскальної каси відкрийте зміну перед операціями з готівкою',
    );
    h.payments.create.mockRejectedValueOnce(boom);
    await expect(createOp(h, validInput('SALE_PAYMENT'))).rejects.toBe(boom);
    expect(h.cash.createOperation).not.toHaveBeenCalled();
    expect(h.settlements.createTransaction).not.toHaveBeenCalled();
    expect(h.cashRows).toEqual([]);
  });

  // guards: BR-CASH-017, BR-CASH-003
  it('рядок оплати для відповіді береться лише у своїй організації', async () => {
    const h = makeDesk();
    // Чужий рядок із тим самим платіжним документом стоїть у журналі раніше за свій.
    h.cashRows.push({
      id: 'op-foreign',
      orgId: OTHER_ORG,
      documentType: 'Payment',
      documentId: 'pay-1',
      amount: 999,
    });
    const result = await createOp(h, validInput('SALE_PAYMENT', { amount: 120 }));
    expect(result.id).not.toBe('op-foreign');
    expect(result.amount).toBe(120);
  });

  // guards: BR-CASH-003
  it('каса чужої організації або видалена → 404, нічого не проведено', async () => {
    for (const patchRow of [{ orgId: OTHER_ORG }, { deletedAt: new Date() }]) {
      const h = makeDesk();
      Object.assign(h.tables.cashRegister.rows[0], patchRow);
      await expect(createOp(h, validInput('SALE_PAYMENT'))).rejects.toThrow(NotFoundException);
      expectNothingMoved(h);
    }
  });

  // guards: BR-CASH-017, BR-CASH-004
  it('одна копійка оплати доходить як 0.01', async () => {
    const h = makeDesk();
    await createOp(h, validInput('SALE_PAYMENT', { amount: 0.01 }));
    expect(paymentCall(h).dto.amount).toBe(0.01);
  });
});

describe('CashDeskService.create — повернення клієнту (REFUND)', () => {
  // guards: BR-CASH-018
  it.each([
    ['клієнт', CLIENT],
    ['«обидва»', BOTH],
  ])(
    'контрагент %s → рядок каси (видача) і REFUND_OUT на ту саму суму, проводка посилається на рядок',
    async (_n, counterpartyId) => {
      const h = makeDesk();
      await createOp(h, validInput('REFUND', { counterpartyId, amount: 780.4, notes: 'брак' }));

      expect(h.cashRows).toHaveLength(1);
      expect(h.cashRows[0]).toMatchObject({
        orgId: ORG,
        cashRegisterId: REG,
        direction: 'OUT',
        reason: 'REFUND',
        amount: 780.4,
        counterpartyId,
        createdBy: USER,
      });

      expect(h.settlementRows).toHaveLength(1);
      expect(h.settlementRows[0]).toMatchObject({
        orgId: ORG,
        counterpartyId,
        type: 'REFUND_OUT',
        amount: 780.4,
        documentType: 'CashOperation',
        documentId: h.cashRows[0].id,
      });
    },
  );

  // guards: BR-CASH-018, BR-CASH-011
  it('рядок каси і проводка йдуть ОДНІЄЮ транзакцією: обидва отримали той самий tx-клієнт', async () => {
    const h = makeDesk();
    await createOp(h, validInput('REFUND'));

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    const cashTx = h.cash.createOperation.mock.calls[0][2];
    const settlementTx = h.settlements.createTransaction.mock.calls[0][2];
    expect(h.isTx(cashTx)).toBe(true);
    expect(settlementTx).toBe(cashTx);
    // Спершу рядок каси (його id потрібен проводці), потім проводка.
    expect(h.cash.createOperation.mock.invocationCallOrder[0]).toBeLessThan(
      h.settlements.createTransaction.mock.invocationCallOrder[0],
    );
  });

  // guards: BR-CASH-018, BR-CASH-011
  it('проводка кинула → рядка каси немає: транзакція відкотилась, помилка піднята', async () => {
    const h = makeDesk();
    const boom = new Error('settlement account locked');
    h.settlements.createTransaction.mockRejectedValueOnce(boom);

    await expect(createOp(h, validInput('REFUND', { amount: 500.25 }))).rejects.toBe(boom);

    expect(h.cash.createOperation).toHaveBeenCalledTimes(1);
    expect(h.cashRows).toEqual([]);
    expect(h.settlementRows).toEqual([]);
  });

  // BR-SETL-010: проводка не ідемпотентна, і сервіс повтор НЕ відсіює — від подвійного кліку
  // захищає лише Idempotency-Key на маршруті. Кейс стереже інше: проводка завжди на СВІЙ рядок
  // каси, тобто двох проводок на один рядок (подвійного боргу за одну видачу) не буває.
  // guards: BR-CASH-018, BR-SETL-010
  it('повтор того самого повернення — дві окремі операції: кожна проводка посилається на СВІЙ рядок каси', async () => {
    const h = makeDesk();
    await createOp(h, validInput('REFUND', { amount: 50 }));
    await createOp(h, validInput('REFUND', { amount: 50 }));

    expect(h.cashRows).toHaveLength(2);
    expect(h.settlementRows).toHaveLength(2);
    expect(h.cashRows[0].id).not.toBe(h.cashRows[1].id);
    expect(h.settlementRows.map(r => r.documentId)).toEqual(h.cashRows.map(r => r.id));
  });

  // Рядок каси і проводка йдуть Serializable-транзакцією: паралельна видача з тієї самої каси
  // дає конфлікт серіалізації. На запиті він приходить як P2034, на COMMIT — як DriverAdapterError.
  // guards: BR-CASH-018, BR-CASH-011
  it.each([
    [
      'P2034 на запиті',
      Object.assign(Object.create(Prisma.PrismaClientKnownRequestError.prototype) as Error, {
        code: 'P2034',
      }),
    ],
    [
      'DriverAdapterError на COMMIT',
      Object.assign(new Error('TransactionWriteConflict'), {
        name: 'DriverAdapterError',
        cause: { kind: 'TransactionWriteConflict' },
      }),
    ],
  ])('конфлікт серіалізації (%s) → 400 «каса зайнята», не 500', async (_form, conflict) => {
    const h = makeDesk();
    h.prisma.$transaction.mockRejectedValueOnce(conflict);

    const call = createOp(h, validInput('REFUND'));
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/Каса зайнята паралельною операцією/);
    expect(h.cashRows).toEqual([]);
    expect(h.settlementRows).toEqual([]);
  });

  // guards: BR-CASH-018, BR-CASH-011
  it('транзакція повернення — Serializable', async () => {
    const h = makeDesk();
    await createOp(h, validInput('REFUND'));
    expect(h.prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
  });

  // guards: BR-CASH-018, BR-CASH-006
  it('каса відмовила (недостатньо готівки) → проводки немає, борг клієнта не змінено', async () => {
    const h = makeDesk();
    const boom = new BadRequestException('Недостатньо готівки в касі: доступно 10, потрібно 100');
    h.cash.createOperation.mockRejectedValueOnce(boom);

    await expect(createOp(h, validInput('REFUND'))).rejects.toBe(boom);

    expect(h.settlements.createTransaction).not.toHaveBeenCalled();
    expect(h.cashRows).toEqual([]);
    expect(h.settlementRows).toEqual([]);
  });

  // guards: BR-CASH-018
  it('постачальник у «поверненні клієнту» → 400, нічого не проведено', async () => {
    const h = makeDesk();
    const call = createOp(h, validInput('REFUND', { counterpartyId: SUPPLIER }));
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/постачальник/i);
    expectNothingMoved(h);
  });

  // guards: BR-CASH-018
  it('повернення не створює оплату клієнта й не чіпає оплати постачальникам («сплачено» не змінюється)', async () => {
    const h = makeDesk();
    await createOp(h, validInput('REFUND', { baseDocumentType: 'WorkOrder', baseDocumentId: WO }));
    expect(h.payments.create).not.toHaveBeenCalled();
    expect(h.supplierPayments.create).not.toHaveBeenCalled();
    expect(h.supplierPayments.confirm).not.toHaveBeenCalled();
    expect(h.settlements.createTransaction).toHaveBeenCalledTimes(1);
  });

  // Борг ведеться в базовій валюті. Проводка мусить узяти валюту каси й ТОЙ САМИЙ курс, яким
  // записано рядок каси: власний перерахунок дав би іншу базову суму, ніж у журналі каси.
  // guards: BR-CASH-018
  it('валютна каса: проводка несе валюту каси й курс рядка каси', async () => {
    const h = makeDesk();
    h.tables.cashRegister.rows[0].currencyId = 'usd-id';
    h.cash.createOperation.mockImplementationOnce((orgId: string, input: MemRow) =>
      Promise.resolve({ id: 'op-usd', orgId, ...input, amountBase: 144.02, rateUsed: 43.25 }),
    );
    await createOp(h, validInput('REFUND', { amount: 3.33 }));
    expect(h.settlementRows[0]).toMatchObject({
      type: 'REFUND_OUT',
      amount: 3.33,
      currencyId: 'usd-id',
      conversion: { amountBase: 144.02, rateUsed: 43.25 },
      documentId: 'op-usd',
    });
  });

  // guards: BR-CASH-018, BR-CASH-004
  it('одна копійка повернення: і в касі, і в проводці 0.01', async () => {
    const h = makeDesk();
    await createOp(h, validInput('REFUND', { amount: 0.01 }));
    expect(h.cashRows[0].amount).toBe(0.01);
    expect(h.settlementRows[0].amount).toBe(0.01);
  });
});
