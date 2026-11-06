import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { describe, it, expect } from 'vitest';
import type { BankTransactionAllocationDto, CreateBankTransactionDto } from './bank-statement.dto';
import {
  ID,
  NO_EFFECTS,
  ORG,
  OTHER_ORG,
  USER,
  effectCalls,
  makeWorld,
  type World,
} from './bank-reconciliation.world.spec-fixture';

// Аспект: внесення платежу разом із рознесенням — BankReconciliationService.createManual з
// `allocation` (BR-BANK-041). Одна дія і ОДНА транзакція БД для всіх видів (з 2026-11-06, Bug
// #1023): платіж внесено й рознесено; рознесення не вдалося — немає нічого (ні рядка, ні оплати).
// Правила рознесення самі по собі — BR-BANK-008…010, 025…035 (їхні спеки: posting / outgoing /
// supplier-payment).
//
// Mutation-verify (кожна мутація валить названі кейси):
//  · `planAllocation` після вставки рядка (а не до)          → «перевірка до вставки: … рядка не вставлено»;
//  · прибрати перевірку напряму для вхідних видів              → «SERVICE на вихідному → 400»;
//  · прибрати «без контрагента → 400» для вхідних              → «вхідний вид без контрагента»;
//  · `this.prisma.bankTransaction.create` замість `tx.`         → «відмова в транзакції — рядка немає»,
//    «відмова оплати → ні рядка, ні оплати»;
//  · `payments.createInTx(this.prisma, …)` замість `tx`         → «оплату створено, а далі збій → нічого»;
//  · `createAndConfirmInTx(this.prisma, …)` замість `tx`        → «оплату постачальнику створено, а далі збій».

const PAYMENT_ID = ID.payment;
const INVOICE = '00000000-0000-4000-8000-000000000501';
const INVOICE_OTHER_CP = '00000000-0000-4000-8000-000000000502';

const dto = (
  allocation: BankTransactionAllocationDto | undefined,
  over: Partial<CreateBankTransactionDto> = {},
): CreateBankTransactionDto => ({
  bankAccountId: ID.account,
  direction: 'OUT',
  amount: 2400.75,
  operationDate: '2026-10-09',
  payerName: 'ФОП Коваленко',
  purpose: 'Оренда приміщення за жовтень',
  allocation,
  ...over,
});
const incoming = (
  allocation: BankTransactionAllocationDto,
  over: Partial<CreateBankTransactionDto> = {},
) => dto(allocation, { direction: 'IN', ...over });

async function world(): Promise<World> {
  const w = await makeWorld();
  w.db.seed('invoice', { id: INVOICE, orgId: ORG, counterpartyId: ID.client, number: 'INV-0042' });
  w.db.seed('invoice', {
    id: INVOICE_OTHER_CP,
    orgId: ORG,
    counterpartyId: ID.both,
    number: 'INV-0043',
  });
  return w;
}

/** Рядки виписки, яких користувач бачить (не видалені). */
const live = (w: World) => w.db.rows('bankTransaction').filter(r => r.deletedAt == null);
/** Єдиний внесений рядок (живий чи прибраний). */
function only(w: World): Record<string, unknown> {
  const rows = w.db.rows('bankTransaction');
  expect(rows).toHaveLength(1);
  return rows[0]!;
}
const inserts = (w: World) => w.calls('bankTransaction', 'create');

describe('createManual з allocation — вхідні види (BR-BANK-041)', () => {
  // guards: BR-BANK-041, BR-BANK-008
  it.each([
    ['PREPAYMENT', 'PREPAYMENT'],
    ['SERVICE', 'PAYMENT'],
    ['REFUND', 'REFUND'],
    ['OTHER', 'PAYMENT'],
  ] as const)('%s → рядок MATCHED з оплатою (settlementType %s)', async (type, settlementType) => {
    const w = await world();

    const res = await w.service.createManual(
      ORG,
      incoming({ type, counterpartyId: ID.client }),
      USER,
    );

    const row = only(w);
    expect(row).toMatchObject({
      source: 'MANUAL',
      direction: 'IN',
      status: 'MATCHED',
      matchedType: type,
      counterpartyId: ID.client,
      paymentId: PAYMENT_ID,
      matchedBy: USER,
      deletedAt: null,
    });
    expect(w.payments.createInTx).toHaveBeenCalledTimes(1);
    expect(w.payments.createInTx.mock.calls[0]![0]).toBe(w.tx);
    expect(w.payments.afterCreate).toHaveBeenCalledTimes(1);
    expect(w.payments.prepareCreate.mock.calls[0]![1]).toMatchObject({
      counterpartyId: ID.client,
      invoiceId: undefined,
      amount: 2400.75,
      method: 'bank',
      sourceType: 'BANK_ACCOUNT',
      bankAccountId: ID.account,
      settlementType,
    });
    expect(res).toMatchObject({ id: row.id, status: 'MATCHED', counterpartyName: 'Контрагент 30' });
  });

  // guards: BR-BANK-041, BR-BANK-008
  it('INVOICE → оплата рахунку клієнта: invoiceId іде в оплату, рядок MATCHED', async () => {
    const w = await world();

    await w.service.createManual(
      ORG,
      incoming({ type: 'INVOICE', counterpartyId: ID.client, invoiceId: INVOICE }),
      USER,
    );

    expect(only(w)).toMatchObject({
      status: 'MATCHED',
      matchedType: 'INVOICE',
      paymentId: PAYMENT_ID,
    });
    expect(w.payments.prepareCreate.mock.calls[0]![1]).toMatchObject({
      invoiceId: INVOICE,
      settlementType: 'PAYMENT',
    });
  });

  // guards: BR-BANK-041, BR-BANK-033
  it('TRANSFER для вхідного → рядок MATCHED з рахунком переказу, нічого не проводиться', async () => {
    const w = await world();

    await w.service.createManual(
      ORG,
      incoming({ type: 'TRANSFER', transferBankAccountId: ID.account2 }),
      USER,
    );

    expect(only(w)).toMatchObject({
      direction: 'IN',
      status: 'MATCHED',
      matchedType: 'TRANSFER',
      transferBankAccountId: ID.account2,
    });
    expect(effectCalls(w)).toEqual(NO_EFFECTS);
  });

  // guards: BR-BANK-041, BR-BANK-009
  it('відмова оплати (сума більша за залишок рахунку) → ні рядка, ні оплати, клієнт отримує ту саму помилку', async () => {
    const w = await world();
    const refusal = new BadRequestException(
      'Сума перевищує залишок до сплати за рахунком (100.00)',
    );
    w.payments.createInTx.mockRejectedValueOnce(refusal);

    await expect(
      w.service.createManual(
        ORG,
        incoming({ type: 'INVOICE', counterpartyId: ID.client, invoiceId: INVOICE }),
        USER,
      ),
    ).rejects.toBe(refusal);

    // Рядок вставлено в ту саму транзакцію — він відкотився разом з нею; м'якого видалення немає.
    expect(w.db.rows('bankTransaction')).toEqual([]);
    expect(w.db.rows('payment')).toEqual([]);
    expect(w.tx.bankTransaction.create).toHaveBeenCalledTimes(1);
    expect(w.prisma.bankTransaction.create).not.toHaveBeenCalled();
    expect(w.payments.afterCreate).not.toHaveBeenCalled();
  });

  // guards: BR-BANK-041
  it('повтор після відмови проходить: один рядок, рознесений, одна оплата', async () => {
    const w = await world();
    w.payments.createInTx.mockRejectedValueOnce(new BadRequestException('Рахунок уже оплачено'));
    const body = incoming({ type: 'SERVICE', counterpartyId: ID.client });

    await expect(w.service.createManual(ORG, body, USER)).rejects.toThrow('Рахунок уже оплачено');
    await w.service.createManual(ORG, body, USER);

    expect(live(w)).toHaveLength(1);
    expect(only(w)).toMatchObject({ status: 'MATCHED', paymentId: PAYMENT_ID });
    expect(w.db.rows('payment')).toHaveLength(1);
  });

  // Оплату створено (createInTx відпрацював), а запис paymentId у рядок упав. До 2026-11-06 рядок
  // лишався MATCHED без посилання (кілька комітів); тепер відкочується все — і оплата теж, тож
  // повторне внесення не заплатить удруге (Bug #1023).
  // guards: BR-BANK-041, BR-BANK-009
  it('оплату створено, а далі збій → немає ні рядка, ні оплати, ефектів після коміту немає', async () => {
    const w = await world();
    const updateMany = w.tx.bankTransaction.updateMany;
    const real = updateMany.getMockImplementation()!;
    updateMany
      .mockImplementationOnce(real) // CAS-захоплення
      .mockImplementationOnce(() => Promise.reject(new Error('БД недоступна'))); // посилання paymentId

    await expect(
      w.service.createManual(ORG, incoming({ type: 'SERVICE', counterpartyId: ID.client }), USER),
    ).rejects.toThrow('БД недоступна');

    expect(w.payments.createInTx).toHaveBeenCalledTimes(1);
    expect(w.db.rows('payment')).toEqual([]);
    expect(w.db.rows('bankTransaction')).toEqual([]);
    expect(w.payments.afterCreate).not.toHaveBeenCalled();
  });

  // Відповідь читається в транзакції (маршрут під ключем ідемпотентності), ефекти — після коміту.
  // guards: BR-BANK-041
  it('вхідний вид: відповідь читається в транзакції, пост-комітні ефекти — після неї', async () => {
    const w = await world();

    const res = await w.service.createManual(
      ORG,
      incoming({ type: 'SERVICE', counterpartyId: ID.client }),
      USER,
    );

    expect(w.tx.bankTransaction.findFirstOrThrow).toHaveBeenCalledTimes(1);
    expect(w.prisma.bankTransaction.findFirstOrThrow).not.toHaveBeenCalled();
    expect(w.payments.afterCreate).toHaveBeenCalledTimes(1);
    expect(w.payments.afterCreate.mock.calls[0]![1].payment.id).toBe(PAYMENT_ID);
    expect(res).toMatchObject({ status: 'MATCHED', paymentId: PAYMENT_ID });
  });
});

describe('createManual з allocation — вихідні види (BR-BANK-041)', () => {
  // guards: BR-BANK-041, BR-BANK-031
  it('EXPENSE → вставка й рознесення в одній транзакції БД, рядок MATCHED зі статтею', async () => {
    const w = await world();

    const res = await w.service.createManual(
      ORG,
      dto({ type: 'EXPENSE', expenseCategoryId: ID.expense, counterpartyId: ID.supplier }),
      USER,
    );

    const row = only(w);
    expect(row).toMatchObject({
      source: 'MANUAL',
      direction: 'OUT',
      status: 'MATCHED',
      matchedType: 'EXPENSE',
      expenseCategoryId: ID.expense,
      counterpartyId: ID.supplier,
      matchedBy: USER,
    });
    expect(w.tx.bankTransaction.create).toHaveBeenCalledTimes(1);
    expect(w.prisma.bankTransaction.create).not.toHaveBeenCalled();
    expect(effectCalls(w)).toEqual(NO_EFFECTS);
    expect(res).toMatchObject({ id: row.id, status: 'MATCHED', expenseCategoryName: 'Стаття 40' });
  });

  // Маршрут під ключем ідемпотентності: читання після коміту, що впало, зняло б резервацію
  // ключа, і повтор вніс і розніс би платіж удруге.
  // guards: BR-BANK-041
  it('відповідь читається в транзакції вставки й рознесення, а не після коміту', async () => {
    const w = await world();

    const res = await w.service.createManual(
      ORG,
      dto({ type: 'EXPENSE', expenseCategoryId: ID.expense, counterpartyId: ID.supplier }),
      USER,
    );

    expect(w.calls('bankTransaction', 'findFirstOrThrow')).toHaveLength(1);
    expect(w.tx.bankTransaction.findFirstOrThrow).toHaveBeenCalledTimes(1);
    expect(w.prisma.bankTransaction.findFirstOrThrow).not.toHaveBeenCalled();
    expect(res).toMatchObject({ id: only(w).id, status: 'MATCHED' });
  });

  // guards: BR-BANK-041, BR-BANK-032
  it('PAYROLL → рядок MATCHED з періодом і працівником', async () => {
    const w = await world();

    await w.service.createManual(
      ORG,
      dto({ type: 'PAYROLL', payrollPeriodId: ID.periodComputed, employeeId: ID.employee }),
      USER,
    );

    expect(only(w)).toMatchObject({
      status: 'MATCHED',
      matchedType: 'PAYROLL',
      payrollPeriodId: ID.periodComputed,
      employeeId: ID.employee,
    });
  });

  // guards: BR-BANK-041, BR-BANK-033
  it('TRANSFER → рядок MATCHED з рахунком переказу', async () => {
    const w = await world();

    await w.service.createManual(
      ORG,
      dto({ type: 'TRANSFER', transferBankAccountId: ID.account2 }),
      USER,
    );

    expect(only(w)).toMatchObject({ status: 'MATCHED', transferBankAccountId: ID.account2 });
  });

  // guards: BR-BANK-041, BR-BANK-030
  it('CLIENT_REFUND → одне проведення REFUND_OUT через tx-клієнт на id нового рядка', async () => {
    const w = await world();

    await w.service.createManual(
      ORG,
      dto({ type: 'CLIENT_REFUND', counterpartyId: ID.client }),
      USER,
    );

    const row = only(w);
    expect(row).toMatchObject({ status: 'MATCHED', counterpartyId: ID.client });
    expect(w.settlements.createTransaction).toHaveBeenCalledTimes(1);
    const [orgArg, input, client] = w.settlements.createTransaction.mock.calls[0]!;
    expect(orgArg).toBe(ORG);
    expect(input).toMatchObject({
      counterpartyId: ID.client,
      type: 'REFUND_OUT',
      amount: 2400.75,
      currencyId: ID.uah,
      documentType: 'BankTransaction',
      documentId: row.id,
    });
    // Курс — на дату операції внесеного рядка; та сама конверсія — і в ліміті переплати (BR-BANK-044).
    const rateDates = w.exchange.resolveBaseConversion.mock.calls.map(c =>
      (c[2] as Date).toISOString(),
    );
    expect(rateDates.every(d => d === '2026-10-09T00:00:00.000Z')).toBe(true);
    expect(input.conversion).toMatchObject({ amountBase: 2400.75 });
    expect(client).toBe(w.tx);
  });

  // guards: BR-BANK-041, BR-BANK-034
  it('CASH_WITHDRAWAL → касова операція-надходження в тій самій транзакції, посилання в рядку', async () => {
    const w = await world();

    await w.service.createManual(
      ORG,
      dto({ type: 'CASH_WITHDRAWAL', cashRegisterId: ID.cashUah }),
      USER,
    );

    const row = only(w);
    const ops = w.db.rows('cashOperation');
    expect(ops).toHaveLength(1);
    expect(row).toMatchObject({ status: 'MATCHED', cashOperationId: ops[0]!.id });
    expect(w.cash.createOperation.mock.calls[0]![1]).toMatchObject({
      cashRegisterId: ID.cashUah,
      direction: 'IN',
      reason: 'BANK_WITHDRAWAL',
      amount: 2400.75,
      documentId: row.id,
    });
    expect(w.cash.createOperation.mock.calls[0]![2]).toBe(w.tx);
  });

  // guards: BR-BANK-041, BR-BANK-028
  it('SUPPLIER_PAYMENT → нова оплата постачальнику створена й проведена, рядок MATCHED з нею', async () => {
    const w = await world();

    await w.service.createManual(
      ORG,
      dto({ type: 'SUPPLIER_PAYMENT', counterpartyId: ID.supplier, purchaseOrderId: ID.po }),
      USER,
    );

    const row = only(w);
    expect(row).toMatchObject({
      status: 'MATCHED',
      matchedType: 'SUPPLIER_PAYMENT',
      counterpartyId: ID.supplier,
      supplierPaymentId: ID.spNew,
    });
    expect(w.supplierPayments.prepareCreateAndConfirm.mock.calls[0]![1]).toMatchObject({
      supplierId: ID.supplier,
      sourceType: 'BANK_ACCOUNT',
      bankAccountId: ID.account,
      amount: 2400.75,
      documentDate: '2026-10-09',
      purchaseOrderId: ID.po,
    });
    expect(w.supplierPayments.createAndConfirmInTx.mock.calls[0]![0]).toBe(w.tx);
    // Оплата пам'ятає рядок, з якого її створено (BR-BANK-039).
    expect(w.db.get('supplierPayment', ID.spNew)).toMatchObject({
      status: 'CONFIRMED',
      originBankTransactionId: row.id,
    });
  });

  // Відмова всередині транзакції: рядок вставлено тим самим tx-клієнтом, тож відкочується з нею.
  // guards: BR-BANK-041, BR-BANK-034
  it('відмова каси всередині транзакції → рядка немає, клієнт отримує ту саму помилку', async () => {
    const w = await world();
    const refusal = new BadRequestException('Фіскальна каса: зміну не відкрито');
    w.cash.createOperation.mockRejectedValueOnce(refusal);

    await expect(
      w.service.createManual(
        ORG,
        dto({ type: 'CASH_WITHDRAWAL', cashRegisterId: ID.cashUah }),
        USER,
      ),
    ).rejects.toBe(refusal);

    expect(w.db.rows('bankTransaction')).toEqual([]);
    expect(w.tx.bankTransaction.create).toHaveBeenCalledTimes(1);
    expect(w.prisma.bankTransaction.create).not.toHaveBeenCalled();
  });

  // guards: BR-BANK-041, BR-BANK-030
  it('відмова проведення повернення → рядка немає', async () => {
    const w = await world();
    w.settlements.createTransaction.mockRejectedValueOnce(new Error('курсу немає'));

    await expect(
      w.service.createManual(ORG, dto({ type: 'CLIENT_REFUND', counterpartyId: ID.client }), USER),
    ).rejects.toThrow('курсу немає');

    expect(w.db.rows('bankTransaction')).toEqual([]);
  });

  // guards: BR-BANK-041, BR-BANK-029
  it('нова оплата постачальнику не провелась → ні рядка, ні оплати, клієнт отримує ту саму помилку', async () => {
    const w = await world();
    const refusal = new BadRequestException('Курсу на дату немає');
    w.supplierPayments.createAndConfirmInTx.mockRejectedValueOnce(refusal);

    await expect(
      w.service.createManual(
        ORG,
        dto({ type: 'SUPPLIER_PAYMENT', counterpartyId: ID.supplier }),
        USER,
      ),
    ).rejects.toBe(refusal);

    expect(w.db.rows('bankTransaction')).toEqual([]);
    expect(w.db.rows('supplierPayment')).toEqual([]);
  });

  // До 2026-11-06 проведена оплата лишала рядок MATCHED (компенсація, BR-BANK-029 стара редакція);
  // тепер збій після проведення відкочує й саму оплату — платити вдруге нема чим.
  // guards: BR-BANK-041, BR-BANK-029
  it('оплату постачальнику створено й проведено, а далі збій → немає ні рядка, ні оплати', async () => {
    const w = await world();
    const updateMany = w.tx.bankTransaction.updateMany;
    const real = updateMany.getMockImplementation()!;
    updateMany
      .mockImplementationOnce(real) // CAS-захоплення
      .mockImplementationOnce(() => Promise.reject(new Error('БД недоступна'))); // посилання

    await expect(
      w.service.createManual(
        ORG,
        dto({ type: 'SUPPLIER_PAYMENT', counterpartyId: ID.supplier }),
        USER,
      ),
    ).rejects.toThrow('БД недоступна');

    expect(w.supplierPayments.createAndConfirmInTx).toHaveBeenCalledTimes(1);
    expect(w.db.rows('supplierPayment')).toEqual([]);
    expect(w.db.rows('bankTransaction')).toEqual([]);
  });
});

describe('createManual з allocation — перевірка до вставки рядка (BR-BANK-041)', () => {
  const rejectsBeforeInsert = async (
    w: World,
    body: CreateBankTransactionDto,
    expected: { status: number; key?: Parameters<typeof translateError>[0] },
  ) => {
    await expect(w.service.createManual(ORG, body, USER)).rejects.toMatchObject({
      status: expected.status,
      ...(expected.key ? { message: translateError(expected.key, 'uk') } : {}),
    });
    expect(inserts(w)).toEqual([]);
    expect(w.db.rows('bankTransaction')).toEqual([]);
    expect(effectCalls(w)).toEqual(NO_EFFECTS);
    expect(w.exchange.resolveBaseConversion).not.toHaveBeenCalled();
  };

  // guards: BR-BANK-041, BR-BANK-025
  it.each(['PREPAYMENT', 'SERVICE', 'INVOICE', 'REFUND', 'OTHER'] as const)(
    'вхідний вид %s на вихідному платежі → 400, рядка не вставлено',
    async type => {
      const w = await world();
      await rejectsBeforeInsert(w, dto({ type, counterpartyId: ID.client, invoiceId: INVOICE }), {
        status: 400,
        key: 'err.bankStatement.wrongDirection',
      });
    },
  );

  // guards: BR-BANK-041, BR-BANK-025
  it.each(['SUPPLIER_PAYMENT', 'CLIENT_REFUND', 'EXPENSE', 'PAYROLL', 'CASH_WITHDRAWAL'] as const)(
    'вихідний вид %s на вхідному платежі → 400, рядка не вставлено',
    async type => {
      const w = await world();
      await rejectsBeforeInsert(
        w,
        incoming({
          type,
          counterpartyId: ID.both,
          expenseCategoryId: ID.expense,
          payrollPeriodId: ID.periodComputed,
          cashRegisterId: ID.cashUah,
        }),
        { status: 400, key: 'err.bankStatement.wrongDirection' },
      );
    },
  );

  // guards: BR-BANK-041, BR-BANK-010
  it('вхідний вид без контрагента → 400 «не вказано обов’язкове поле»', async () => {
    const w = await world();
    await rejectsBeforeInsert(w, incoming({ type: 'SERVICE' }), {
      status: 400,
      key: 'err.bankStatement.fieldRequiredForType',
    });
  });

  // guards: BR-BANK-041, BR-BANK-010
  it.each([
    ['INVOICE без рахунку', { type: 'INVOICE', counterpartyId: ID.client }, 400],
    [
      'рахунок іншого контрагента',
      { type: 'INVOICE', counterpartyId: ID.client, invoiceId: INVOICE_OTHER_CP },
      400,
    ],
    ['контрагент чужої організації', { type: 'SERVICE', counterpartyId: ID.cpForeign }, 404],
    ['видалений контрагент', { type: 'PREPAYMENT', counterpartyId: ID.cpDeleted }, 404],
  ] as const)('вхідний: %s → відмова, рядка не вставлено', async (_name, allocation, status) => {
    const w = await world();
    await rejectsBeforeInsert(w, incoming({ ...allocation }), { status });
  });

  // guards: BR-BANK-041, BR-BANK-031, BR-BANK-032, BR-BANK-033, BR-BANK-034, BR-BANK-038
  it.each([
    ['неактивна стаття', { type: 'EXPENSE', expenseCategoryId: ID.expenseInactive }, 400],
    ['стаття чужої організації', { type: 'EXPENSE', expenseCategoryId: ID.expenseForeign }, 400],
    ['період-чернетка', { type: 'PAYROLL', payrollPeriodId: ID.periodDraft }, 400],
    [
      'працівник без рядка в періоді',
      { type: 'PAYROLL', payrollPeriodId: ID.periodComputed, employeeId: ID.employeeNoLine },
      400,
    ],
    ['переказ на той самий рахунок', { type: 'TRANSFER', transferBankAccountId: ID.account }, 400],
    ['каса іншої валюти', { type: 'CASH_WITHDRAWAL', cashRegisterId: ID.cashUsd }, 400],
    ['каса чужої організації', { type: 'CASH_WITHDRAWAL', cashRegisterId: ID.cashForeign }, 400],
    ['повернення не клієнту', { type: 'CLIENT_REFUND', counterpartyId: ID.supplier }, 400],
    [
      'оплата постачальнику — клієнту',
      { type: 'SUPPLIER_PAYMENT', counterpartyId: ID.client },
      400,
    ],
    [
      'замовлення іншого постачальника',
      {
        type: 'SUPPLIER_PAYMENT',
        counterpartyId: ID.supplier,
        purchaseOrderId: ID.poOtherSupplier,
      },
      400,
    ],
    ['стаття не вказана', { type: 'EXPENSE' }, 400],
  ] as const)('вихідний: %s → відмова, рядка не вставлено', async (_name, allocation, status) => {
    const w = await world();
    await rejectsBeforeInsert(w, dto({ ...allocation }), { status });
  });

  // Рішення власника №9: валюта рядка — валюта рахунку платежу; валютний платіж переказом на
  // гривневий рахунок не вноситься. Мутація: прибрати перевірку валюти в planTransfer → кейс червоніє.
  // guards: BR-BANK-041, BR-BANK-033
  it('вихідний: валютний платіж переказом на рахунок іншої валюти → 400, рядка не вставлено', async () => {
    const w = await world();
    await rejectsBeforeInsert(
      w,
      dto(
        { type: 'TRANSFER', transferBankAccountId: ID.account2 },
        { bankAccountId: ID.accountUsd },
      ),
      { status: 400, key: 'err.bankStatement.transferCurrencyMismatch' },
    );
  });

  // guards: BR-BANK-041, BR-BANK-016
  it('рахунок платежу чужої організації → 404 ще до перевірок рознесення', async () => {
    const w = await world();
    await rejectsBeforeInsert(
      w,
      dto({ type: 'EXPENSE', expenseCategoryId: ID.expense }, { bankAccountId: ID.accountForeign }),
      { status: 404, key: 'err.bankStatement.bankAccountNotFound' },
    );
    expect(w.db.rows('bankAccount').find(a => a.id === ID.accountForeign)?.orgId).toBe(OTHER_ORG);
  });
});

describe('createManual без allocation (BR-BANK-023)', () => {
  // guards: BR-BANK-023, BR-BANK-041
  it('як раніше: рядок UNMATCHED, без транзакції БД і без рознесення', async () => {
    const w = await world();

    const res = await w.service.createManual(ORG, dto(undefined), USER);

    const row = only(w);
    expect(row).toMatchObject({ status: 'UNMATCHED', deletedAt: null });
    expect(row.matchedType ?? null).toBeNull();
    expect(res.status).toBe('UNMATCHED');
    expect(w.prisma.$transaction).not.toHaveBeenCalled();
    expect(w.statusWrites('MATCHED')).toEqual([]);
    expect(effectCalls(w)).toEqual(NO_EFFECTS);
  });
});
