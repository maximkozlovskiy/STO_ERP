/**
 * Привід визначає напрям і обов'язкові поля ручної касової операції (BR-CASH-016).
 *
 * Цикли йдуть по `CASH_REASON_RULES` — тій самій таблиці, яку читають форма і сервер: кожен
 * рядок таблиці отримує і відмову, і успіх. Гілки з контрагентом (оплата, повернення) докладно
 * розбирають `cash-desk.client.spec.ts` і `cash-desk.supplier.spec.ts`; тут — лише те, що
 * спільне для всіх приводів, і «прості» приводи, які рухають тільки касу.
 */
import { describe, it, expect } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CASH_REASON_RULES, CASH_REASON_VALUES } from '@sto/shared';
import {
  CAT_EXPENSE,
  DELETED_CLIENT,
  DELETED_EMP,
  DELETED_SUPPLIER,
  EMP,
  FOREIGN_CP,
  FOREIGN_EMP,
  MISSING,
  ORG,
  REG,
  USER,
  createOp,
  expectNothingMoved,
  makeDesk,
  validInput,
} from './cash-desk.spec-fixture';

const MANUAL = CASH_REASON_VALUES.filter(r => CASH_REASON_RULES[r].manual);
const WITH_COUNTERPARTY = MANUAL.filter(r => CASH_REASON_RULES[r].counterparty);
const WITH_EMPLOYEE = MANUAL.filter(r => CASH_REASON_RULES[r].employee);
/** Приводи, які рухають лише касу: без оплат і без взаєморозрахунків. */
const SIMPLE = MANUAL.filter(r => !CASH_REASON_RULES[r].counterparty);

describe('CashDeskService.create — привід і напрям', () => {
  // guards: BR-CASH-016
  it.each(MANUAL)('%s із протилежним напрямом → 400, нічого не проведено', async reason => {
    const h = makeDesk();
    const opposite = CASH_REASON_RULES[reason].direction === 'IN' ? 'OUT' : 'IN';
    const call = createOp(h, validInput(reason, { direction: opposite }));
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/не відповідає напряму/);
    expectNothingMoved(h);
  });

  // guards: BR-CASH-016
  it('PAYROLL вручну (з правильним напрямом OUT) → 400 «ставить лише система»', async () => {
    const h = makeDesk();
    const call = createOp(h, { direction: 'OUT', reason: 'PAYROLL', amount: 100, employeeId: EMP });
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/ставить лише система/);
    expectNothingMoved(h);
  });

  // guards: BR-CASH-016
  it('таблиця справді містить по сім ручних приводів на напрям — цикли не порожні', () => {
    expect(MANUAL.filter(r => CASH_REASON_RULES[r].direction === 'IN')).toHaveLength(7);
    expect(MANUAL.filter(r => CASH_REASON_RULES[r].direction === 'OUT')).toHaveLength(7);
    expect(SIMPLE).toHaveLength(10);
  });
});

describe('CashDeskService.create — обов’язковий контрагент', () => {
  // guards: BR-CASH-016
  it.each(WITH_COUNTERPARTY)('%s без контрагента → 400 «вкажіть контрагента»', async reason => {
    const h = makeDesk();
    const call = createOp(h, validInput(reason, { counterpartyId: undefined }));
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/вкажіть контрагента/);
    expectNothingMoved(h);
  });

  // guards: BR-CASH-016, BR-CASH-003
  it.each(WITH_COUNTERPARTY)(
    '%s: контрагент ЧУЖОЇ організації → 404 «Контрагента не знайдено»',
    async reason => {
      const h = makeDesk();
      // FOREIGN_CP має тип BOTH — відмову дає саме чужий orgId, а не роль.
      const call = createOp(h, validInput(reason, { counterpartyId: FOREIGN_CP }));
      await expect(call).rejects.toThrow(NotFoundException);
      await expect(call).rejects.toThrow(/Контрагента не знайдено/);
      expectNothingMoved(h);
    },
  );

  // guards: BR-CASH-016
  it.each(WITH_COUNTERPARTY)('%s: ВИДАЛЕНИЙ контрагент → 404', async reason => {
    const h = makeDesk();
    const deleted =
      CASH_REASON_RULES[reason].counterparty === 'client' ? DELETED_CLIENT : DELETED_SUPPLIER;
    const call = createOp(h, validInput(reason, { counterpartyId: deleted }));
    await expect(call).rejects.toThrow(NotFoundException);
    await expect(call).rejects.toThrow(/Контрагента не знайдено/);
    expectNothingMoved(h);
  });

  // guards: BR-CASH-016
  it.each(WITH_COUNTERPARTY)('%s: контрагента з таким id немає → 404', async reason => {
    const h = makeDesk();
    await expect(createOp(h, validInput(reason, { counterpartyId: MISSING }))).rejects.toThrow(
      NotFoundException,
    );
    expectNothingMoved(h);
  });
});

describe('CashDeskService.create — обов’язковий працівник', () => {
  // guards: BR-CASH-016
  it.each(WITH_EMPLOYEE)('%s без працівника → 400 «вкажіть працівника»', async reason => {
    const h = makeDesk();
    const call = createOp(h, validInput(reason, { employeeId: undefined }));
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/вкажіть працівника/);
    expectNothingMoved(h);
  });

  // guards: BR-CASH-016, BR-CASH-003
  it.each(WITH_EMPLOYEE)(
    '%s: працівник ЧУЖОЇ організації → 404 «Працівника не знайдено»',
    async reason => {
      const h = makeDesk();
      const call = createOp(h, validInput(reason, { employeeId: FOREIGN_EMP }));
      await expect(call).rejects.toThrow(NotFoundException);
      await expect(call).rejects.toThrow(/Працівника не знайдено/);
      expectNothingMoved(h);
    },
  );

  // guards: BR-CASH-016
  it.each(WITH_EMPLOYEE)('%s: ВИДАЛЕНИЙ працівник → 404', async reason => {
    const h = makeDesk();
    const call = createOp(h, validInput(reason, { employeeId: DELETED_EMP }));
    await expect(call).rejects.toThrow(NotFoundException);
    await expect(call).rejects.toThrow(/Працівника не знайдено/);
    expectNothingMoved(h);
  });

  // guards: BR-CASH-016
  it.each(WITH_EMPLOYEE)('%s: працівник доходить до рядка каси', async reason => {
    const h = makeDesk();
    await createOp(h, validInput(reason));
    expect(h.cash.createOperation).toHaveBeenCalledTimes(1);
    expect(h.cash.createOperation.mock.calls[0][1]).toMatchObject({ reason, employeeId: EMP });
  });
});

describe('CashDeskService.create — стаття для «витрати»', () => {
  // guards: BR-CASH-016, BR-CASH-008
  it('EXPENSE без статті → 400 «вкажіть статтю», нічого не проведено', async () => {
    const h = makeDesk();
    const call = createOp(h, validInput('EXPENSE', { expenseCategoryId: undefined }));
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/вкажіть статтю/);
    expectNothingMoved(h);
  });

  // guards: BR-CASH-016, BR-CASH-008
  it('EXPENSE зі статтею → рядок каси зі статтею', async () => {
    const h = makeDesk();
    await createOp(h, validInput('EXPENSE'));
    expect(h.cash.createOperation.mock.calls[0][1]).toMatchObject({
      reason: 'EXPENSE',
      direction: 'OUT',
      expenseCategoryId: CAT_EXPENSE,
    });
  });
});

describe('CashDeskService.create — прості приводи рухають лише касу', () => {
  // guards: BR-CASH-016
  it.each(SIMPLE)(
    '%s: один рядок каси з приводом, напрямом, сумою з копійками й автором; ні оплат, ні взаєморозрахунків',
    async reason => {
      const h = makeDesk();
      await createOp(h, validInput(reason, { amount: 1250.75, notes: 'за жовтень' }));

      expect(h.cash.createOperation).toHaveBeenCalledTimes(1);
      const [orgId, input] = h.cash.createOperation.mock.calls[0];
      expect(orgId).toBe(ORG);
      expect(input).toMatchObject({
        cashRegisterId: REG,
        direction: CASH_REASON_RULES[reason].direction,
        reason,
        amount: 1250.75,
        notes: 'за жовтень',
        createdBy: USER,
      });

      expect(h.payments.create).not.toHaveBeenCalled();
      expect(h.supplierPayments.createAndConfirm).not.toHaveBeenCalled();
      expect(h.settlements.createTransaction).not.toHaveBeenCalled();
      expect(h.settlementRows).toEqual([]);
      expect(h.cashRows).toHaveLength(1);
    },
  );

  // guards: BR-CASH-016
  it('простий привід не приписує рядку платіжний документ', async () => {
    const h = makeDesk();
    await createOp(h, validInput('OWNER_IN'));
    const input = h.cash.createOperation.mock.calls[0][1];
    expect(input.documentType ?? null).toBeNull();
    expect(input.documentId ?? null).toBeNull();
  });

  // guards: BR-CASH-004
  it('одна копійка — теж сума: 0.01 доходить до каси без округлення в нуль', async () => {
    const h = makeDesk();
    await createOp(h, validInput('MANUAL_IN', { amount: 0.01 }));
    expect(h.cash.createOperation.mock.calls[0][1].amount).toBe(0.01);
  });

  // guards: BR-CASH-016
  it('відмова каси (напр. «недостатньо готівки») піднімається викликачу як є', async () => {
    const h = makeDesk();
    const boom = new BadRequestException('Недостатньо готівки в касі: доступно 10, потрібно 100');
    h.cash.createOperation.mockRejectedValueOnce(boom);
    await expect(createOp(h, validInput('BANK_DEPOSIT'))).rejects.toBe(boom);
    expect(h.cashRows).toEqual([]);
  });
});

// Рішення власника 2026-10-30 (TECH-DEBT (б) №80): оплати з каси йдуть способом «Готівка»; вимкнений
// чи видалений у довіднику спосіб недоступний і тут, як у вікні оплати (BR-PAY-027).
describe('CashDeskService.create — спосіб «Готівка» вимкнено (BR-CASH-031)', () => {
  const disableCash = (h: ReturnType<typeof makeDesk>, over: Record<string, unknown>) =>
    Object.assign(h.tables.paymentMethodConfig.rows[0]!, over);

  // guards: BR-CASH-031
  it.each([
    ['SALE_PAYMENT', 'вимкнено', { isActive: false }],
    ['SUPPLIER_PAYMENT', 'вимкнено', { isActive: false }],
    ['SALE_PAYMENT', 'видалено', { deletedAt: new Date('2026-10-01T00:00:00.000Z') }],
    ['SUPPLIER_PAYMENT', 'видалено', { deletedAt: new Date('2026-10-01T00:00:00.000Z') }],
  ] as const)('%s, «Готівку» %s → 400 до будь-якого запису', async (reason, _label, over) => {
    const h = makeDesk();
    disableCash(h, over);

    await expect(createOp(h, validInput(reason))).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('увімкніть'),
    });
    expectNothingMoved(h);
  });

  // Bug #1019: у картці каси способу не обирають — відмова не радить «оберіть інший» і називає
  // спосіб назвою з довідника, а не кодом.
  it('вимкнена «Готівка» → текст називає спосіб назвою і радить увімкнути, не «оберіть інший»', async () => {
    const h = makeDesk();
    disableCash(h, { isActive: false });

    const err = (await createOp(h, validInput('SALE_PAYMENT')).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toContain('«Готівка»');
    expect(err.message).toContain('увімкніть');
    expect(err.message).not.toContain('оберіть інший');
  });

  // guards: BR-CASH-031
  it('«Готівка» іншої організації не рахується: своєї немає → 400', async () => {
    const h = makeDesk();
    disableCash(h, { orgId: '99999999-9999-4999-8999-999999999999' });

    await expect(createOp(h, validInput('SALE_PAYMENT'))).rejects.toThrow(BadRequestException);
    expectNothingMoved(h);
  });

  // Ручні внесення / вилучення й повернення способом оплати не є — вимкнена «Готівка» їх не чіпає.
  // guards: BR-CASH-031
  it.each(['MANUAL_IN', 'MANUAL_OUT', 'REFUND', 'SUPPLIER_REFUND_IN'] as const)(
    '%s при вимкненій «Готівці» проходить',
    async reason => {
      const h = makeDesk();
      disableCash(h, { isActive: false });

      await createOp(h, validInput(reason));

      expect(h.cashRows).toHaveLength(1);
    },
  );
});
