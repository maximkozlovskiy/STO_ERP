import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { describe, it, expect } from 'vitest';
import {
  BANK_TX_OUT_MATCH_TYPES,
  type BankTxOutMatchType,
  type ReconcileTransactionDto,
} from './bank-statement.dto';
import {
  FREE_ROW,
  ID,
  NO_EFFECTS,
  OP_DATE,
  ORG,
  OTHER_ORG,
  ROW_AMOUNT,
  USER,
  dec,
  effectCalls,
  makeWorld,
  type World,
} from './bank-reconciliation.world.spec-fixture';

// Аспект: рознесення вихідного платежу — BankReconciliationService.reconcile (напрям проти виду,
// обов'язкові поля, CAS, повернення клієнту, зняття готівки, витрата, зарплата, переказ).
// Оплата постачальнику — окремий файл `bank-reconciliation.supplier-payment.spec.ts`.
// Правила BR-BANK-025…034, 038 — docs/objects/bank-statements.md.
//
// Написано ДО реалізації (2026-10-09) з контракту: сигнатура reconcile(orgId, txId, dto, userId),
// ReconcileTransactionDto, схема BankTransaction. Дані — у пам'яті (`makeWorld`): `where` справді
// виконується, `updateMany` — справжній CAS, `$transaction` відкочує записи tx-клієнта.
//
// Mutation-verify (кожна мутація мусить валити названі кейси):
//  · прибрати перевірку напряму в reconcile → «вхідний рядок, вид … → 400»;
//  · прибрати `status: 'UNMATCHED'` з where CAS → «рядок уже рознесений → 409» і «повтор після успіху»;
//  · не перевіряти `count === 0` → «CAS програв гонку → 409, ефект не викликано»;
//  · брати amount / currencyId з dto замість рядка → «CLIENT_REFUND: рівно одне проведення…»;
//  · не передавати tx третім аргументом у createTransaction / createOperation → кейси «…у транзакції рядка»;
//  · винести CAS за межі $transaction (без відкату) → «збій проведення / каси → рядок лишається UNMATCHED»;
//  · прибрати `orgId` або `deletedAt: null` з where будь-якого довідника → кейси «чужа / видалена»;
//  · прибрати перевірку `isActive` / `type` статті, статусу періоду, рядка працівника, «той самий рахунок»,
//    валюти каси → відповідний кейс у блоці виду.

const WRONG_DIRECTION = translateError('err.bankStatement.wrongDirection', 'uk');
const FIELD_REQUIRED = translateError('err.bankStatement.fieldRequiredForType', 'uk');

/** Мінімальний валідний запит для кожного виду (усе засіяне у світі, своє й не видалене). */
const VALID: Record<BankTxOutMatchType, ReconcileTransactionDto> = {
  SUPPLIER_PAYMENT: { type: 'SUPPLIER_PAYMENT', counterpartyId: ID.supplier },
  CLIENT_REFUND: { type: 'CLIENT_REFUND', counterpartyId: ID.client },
  EXPENSE: { type: 'EXPENSE', expenseCategoryId: ID.expense },
  PAYROLL: { type: 'PAYROLL', payrollPeriodId: ID.periodComputed },
  TRANSFER: { type: 'TRANSFER', transferBankAccountId: ID.account2 },
  CASH_WITHDRAWAL: { type: 'CASH_WITHDRAWAL', cashRegisterId: ID.cashUah },
};

const OUT_ONLY = BANK_TX_OUT_MATCH_TYPES.filter(t => t !== 'TRANSFER');

const reconcile = (w: World, dto: ReconcileTransactionDto, txId: string = ID.tx) =>
  w.service.reconcile(ORG, txId, dto, USER);

/** Жодного запису в рядок виписки: ні CAS, ні update — відмова сталась ДО захоплення. */
function expectRowNeverWritten(w: World): void {
  expect(w.calls('bankTransaction', 'updateMany')).toEqual([]);
  expect(w.calls('bankTransaction', 'update')).toEqual([]);
  expect(w.row()).toMatchObject(FREE_ROW);
}

describe('BankReconciliationService.reconcile — вихідні платежі', () => {
  describe('напрям рядка проти виду рознесення', () => {
    // guards: BR-BANK-025
    it.each(OUT_ONLY)(
      'вхідний рядок, вид %s → 400 «не підходить для напряму», жодного запису й ефекту',
      async type => {
        const w = await makeWorld();
        w.addRow({ direction: 'IN' });

        await expect(reconcile(w, VALID[type])).rejects.toMatchObject({
          status: 400,
          message: WRONG_DIRECTION,
        });

        expectRowNeverWritten(w);
        expect(effectCalls(w)).toEqual(NO_EFFECTS);
      },
    );

    // guards: BR-BANK-025, BR-BANK-033
    it('TRANSFER дозволено і для вхідного рядка: MATCHED, інший рахунок записано', async () => {
      const w = await makeWorld();
      w.addRow({ direction: 'IN' });

      const res = await reconcile(w, VALID.TRANSFER);

      expect(w.row()).toMatchObject({
        status: 'MATCHED',
        matchedType: 'TRANSFER',
        transferBankAccountId: ID.account2,
      });
      expect(res).toMatchObject({ id: ID.tx, status: 'MATCHED', matchedType: 'TRANSFER' });
    });

    // guards: BR-BANK-025
    it.each(BANK_TX_OUT_MATCH_TYPES)(
      'вихідний рядок, вид %s → рознесено саме цим видом',
      async type => {
        const w = await makeWorld();
        w.addRow();

        await reconcile(w, VALID[type]);

        expect(w.row()).toMatchObject({ status: 'MATCHED', matchedType: type });
      },
    );
  });

  describe('обов’язкові поля виду — 400 до захоплення рядка', () => {
    const MISSING: Array<[BankTxOutMatchType, string, Omit<ReconcileTransactionDto, 'type'>]> = [
      ['SUPPLIER_PAYMENT', 'ні оплати, ні постачальника', {}],
      ['SUPPLIER_PAYMENT', 'лише замовлення, без постачальника', { purchaseOrderId: ID.po }],
      ['CLIENT_REFUND', 'без контрагента', {}],
      ['CLIENT_REFUND', 'поле чужого виду замість контрагента', { expenseCategoryId: ID.expense }],
      ['EXPENSE', 'без статті витрат', { counterpartyId: ID.supplier }],
      ['PAYROLL', 'без зарплатного періоду', { employeeId: ID.employee }],
      ['TRANSFER', 'без іншого рахунку', { cashRegisterId: ID.cashUah }],
      ['CASH_WITHDRAWAL', 'без каси', { transferBankAccountId: ID.account2 }],
    ];

    // guards: BR-BANK-027, BR-BANK-028, BR-BANK-030, BR-BANK-031, BR-BANK-032, BR-BANK-033, BR-BANK-034
    it.each(MISSING)('%s, %s → 400, рядок не чіпається', async (type, _label, fields) => {
      const w = await makeWorld();
      w.addRow();

      await expect(reconcile(w, { type, ...fields })).rejects.toMatchObject({
        status: 400,
        message: FIELD_REQUIRED,
      });

      expectRowNeverWritten(w);
      expect(effectCalls(w)).toEqual(NO_EFFECTS);
    });
  });

  describe('CAS зі статусу UNMATCHED', () => {
    // guards: BR-BANK-026
    it('захоплення — updateMany з where {id, orgId, status: UNMATCHED} і data.status MATCHED', async () => {
      const w = await makeWorld();
      w.addRow();

      await reconcile(w, VALID.EXPENSE);

      const captures = w.statusWrites('MATCHED');
      expect(captures).toHaveLength(1);
      expect(captures[0]!.where).toMatchObject({ id: ID.tx, orgId: ORG, status: 'UNMATCHED' });
    });

    // guards: BR-BANK-026
    it('matchedAt і matchedBy фіксують, коли й хто розніс', async () => {
      const w = await makeWorld();
      w.addRow();
      const before = Date.now();

      await reconcile(w, VALID.EXPENSE);

      const row = w.row();
      expect(row.matchedBy).toBe(USER);
      expect(row.matchedAt).toBeInstanceOf(Date);
      expect((row.matchedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
      expect((row.matchedAt as Date).getTime()).toBeLessThanOrEqual(Date.now());
    });

    // guards: BR-BANK-026
    it.each(BANK_TX_OUT_MATCH_TYPES)(
      'рядок уже рознесений, вид %s → 409, без ефектів, попереднє рознесення ціле',
      async type => {
        const w = await makeWorld();
        w.addRow({ status: 'MATCHED', matchedType: 'EXPENSE', expenseCategoryId: ID.expense });

        await expect(reconcile(w, VALID[type])).rejects.toMatchObject({ status: 409 });

        expect(effectCalls(w)).toEqual(NO_EFFECTS);
        expect(w.row()).toMatchObject({
          status: 'MATCHED',
          matchedType: 'EXPENSE',
          expenseCategoryId: ID.expense,
        });
      },
    );

    // guards: BR-BANK-026
    it('ігнорований рядок → 409, без ефектів', async () => {
      const w = await makeWorld();
      w.addRow({ status: 'IGNORED', ignoreReason: 'комісія банку' });

      await expect(reconcile(w, VALID.CLIENT_REFUND)).rejects.toMatchObject({ status: 409 });

      expect(effectCalls(w)).toEqual(NO_EFFECTS);
      expect(w.row().status).toBe('IGNORED');
    });

    // Одночасна спроба: рядок ще UNMATCHED на момент читання, але CAS уже програв (count = 0).
    // guards: BR-BANK-026
    it.each(BANK_TX_OUT_MATCH_TYPES)(
      'CAS програв гонку, вид %s → 409, ефект не викликано',
      async type => {
        const w = await makeWorld();
        w.addRow();
        w.loseNextCas();

        await expect(reconcile(w, VALID[type])).rejects.toMatchObject({ status: 409 });

        expect(effectCalls(w)).toEqual(NO_EFFECTS);
      },
    );

    // guards: BR-BANK-026
    it.each(['CLIENT_REFUND', 'CASH_WITHDRAWAL'] as const)(
      'повтор після успіху, вид %s → 409, а ефект лишається рівно одним',
      async type => {
        const w = await makeWorld();
        w.addRow();

        await reconcile(w, VALID[type]);
        await expect(reconcile(w, VALID[type])).rejects.toMatchObject({ status: 409 });

        expect(
          w.settlements.createTransaction.mock.calls.length +
            w.cash.createOperation.mock.calls.length,
        ).toBe(1);
      },
    );

    const MISSING_ROWS: Array<[string, (w: World) => void]> = [
      ['рядка немає', () => undefined],
      ['рядок чужої організації', w => void w.addRow({ orgId: OTHER_ORG })],
      ['рядок видалено', w => void w.addRow({ deletedAt: new Date('2026-10-01') })],
    ];

    // guards: BR-BANK-026, BR-BANK-038
    it.each(MISSING_ROWS)('%s → 404, без ефектів', async (_name, arrange) => {
      const w = await makeWorld();
      arrange(w);

      await expect(reconcile(w, VALID.CLIENT_REFUND)).rejects.toMatchObject({ status: 404 });

      expect(effectCalls(w)).toEqual(NO_EFFECTS);
      expect(w.db.rows('bankTransaction').every(r => r.status === 'UNMATCHED')).toBe(true);
    });
  });

  describe('CLIENT_REFUND — повернення клієнту', () => {
    // Рядок у доларах і запит із підсунутими «своїми» сумою, валютою й датою: усе береться з рядка.
    // guards: BR-BANK-026, BR-BANK-030, BR-BANK-035
    it('рівно одне проведення REFUND_OUT: сума, валюта й дата курсу — з рядка, не з запиту', async () => {
      const w = await makeWorld();
      w.addRow({
        bankAccountId: ID.accountUsd,
        currencyId: ID.usd,
        amount: dec(200),
        amountBase: dec(8300),
        rateUsed: dec(41.5),
      });
      const forged = {
        ...VALID.CLIENT_REFUND,
        amount: 1,
        currencyId: ID.uah,
        bankAccountId: ID.account2,
        operationDate: '2020-01-01',
        date: '2020-01-01',
      } as ReconcileTransactionDto;

      await reconcile(w, forged);

      expect(w.settlements.createTransaction).toHaveBeenCalledTimes(1);
      const [orgArg, posting] = w.settlements.createTransaction.mock.calls[0]!;
      expect(orgArg).toBe(ORG);
      expect(posting).toMatchObject({
        counterpartyId: ID.client,
        type: 'REFUND_OUT',
        amount: 200,
        currencyId: ID.usd,
        documentType: 'BankTransaction',
        documentId: ID.tx,
      });
      // Курс — на дату операції рядка (BR-BANK-030 / 035), а не на «сьогодні» і не з запиту.
      expect(posting.date).toEqual(OP_DATE);
      expect(w.row()).toMatchObject({
        status: 'MATCHED',
        matchedType: 'CLIENT_REFUND',
        counterpartyId: ID.client,
      });
      expect({ ...effectCalls(w), 'settlements.createTransaction': 0 }).toEqual(NO_EFFECTS);
    });

    // guards: BR-BANK-030
    it('проведення і захоплення рядка — в одній транзакції: той самий tx-клієнт', async () => {
      const w = await makeWorld();
      w.addRow();

      await reconcile(w, VALID.CLIENT_REFUND);

      expect(w.prisma.$transaction).toHaveBeenCalledTimes(1);
      // Третій аргумент createTransaction — саме клієнт цієї транзакції.
      expect(w.settlements.createTransaction.mock.calls[0]![2]).toBe(w.tx);
      // І захоплення пішло через нього ж, а не повз транзакцію.
      const viaTx = w.tx.bankTransaction!.updateMany.mock.calls.map(c => c[0]);
      const viaRoot = w.prisma.bankTransaction!.updateMany.mock.calls.map(c => c[0]);
      expect(viaTx.some(a => (a.data as { status?: string }).status === 'MATCHED')).toBe(true);
      expect(viaRoot.some(a => (a.data as { status?: string }).status === 'MATCHED')).toBe(false);
    });

    // guards: BR-BANK-030
    it('проведення впало → помилка пробрасується, рядок лишається UNMATCHED без посилань', async () => {
      const w = await makeWorld();
      w.addRow();
      w.settlements.createTransaction.mockRejectedValueOnce(
        new BadRequestException('Немає курсу на дату'),
      );

      await expect(reconcile(w, VALID.CLIENT_REFUND)).rejects.toThrow('Немає курсу на дату');

      expect(w.row()).toMatchObject({ ...FREE_ROW, matchedAt: null, matchedBy: null });
    });

    // guards: BR-BANK-030
    it('контрагент лише з роллю постачальника → 400, проведення немає', async () => {
      const w = await makeWorld();
      w.addRow();

      await expect(
        reconcile(w, { type: 'CLIENT_REFUND', counterpartyId: ID.supplier }),
      ).rejects.toMatchObject({ status: 400 });

      expect(effectCalls(w)).toEqual(NO_EFFECTS);
      expect(w.row()).toMatchObject(FREE_ROW);
    });

    // guards: BR-BANK-030
    it('контрагент з обома ролями (BOTH) — клієнт: повернення проходить', async () => {
      const w = await makeWorld();
      w.addRow();

      await reconcile(w, { type: 'CLIENT_REFUND', counterpartyId: ID.both });

      expect(w.settlements.createTransaction).toHaveBeenCalledTimes(1);
      expect(w.row()).toMatchObject({ status: 'MATCHED', counterpartyId: ID.both });
    });

    // guards: BR-BANK-038
    it.each([
      ['чужої організації', ID.cpForeign],
      ['видалений', ID.cpDeleted],
    ])('контрагент %s → 404, проведення немає', async (_name, counterpartyId) => {
      const w = await makeWorld();
      w.addRow();

      await expect(reconcile(w, { type: 'CLIENT_REFUND', counterpartyId })).rejects.toMatchObject({
        status: 404,
      });

      expect(effectCalls(w)).toEqual(NO_EFFECTS);
      expect(w.row()).toMatchObject(FREE_ROW);
    });
  });

  describe('CASH_WITHDRAWAL — зняття готівки в касу', () => {
    // guards: BR-BANK-026, BR-BANK-034
    it('рівно одна касова операція IN / MANUAL_IN на суму рядка з посиланням на рядок; cashOperationId записано', async () => {
      const w = await makeWorld();
      w.addRow();
      const forged = { ...VALID.CASH_WITHDRAWAL, amount: 1 } as ReconcileTransactionDto;

      await reconcile(w, forged);

      expect(w.cash.createOperation).toHaveBeenCalledTimes(1);
      const [orgArg, input] = w.cash.createOperation.mock.calls[0]!;
      expect(orgArg).toBe(ORG);
      expect(input).toMatchObject({
        cashRegisterId: ID.cashUah,
        direction: 'IN',
        reason: 'MANUAL_IN',
        amount: ROW_AMOUNT,
        documentType: 'BankTransaction',
        documentId: ID.tx,
      });
      const operations = w.db.rows('cashOperation');
      expect(operations).toHaveLength(1);
      expect(w.row()).toMatchObject({
        status: 'MATCHED',
        matchedType: 'CASH_WITHDRAWAL',
        cashOperationId: operations[0]!.id,
      });
      expect({ ...effectCalls(w), 'cash.createOperation': 0 }).toEqual(NO_EFFECTS);
    });

    // guards: BR-BANK-034
    it('касова операція і захоплення рядка — в одній транзакції: той самий tx-клієнт', async () => {
      const w = await makeWorld();
      w.addRow();

      await reconcile(w, VALID.CASH_WITHDRAWAL);

      expect(w.prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(w.cash.createOperation.mock.calls[0]![2]).toBe(w.tx);
      const viaTx = w.tx.bankTransaction!.updateMany.mock.calls.map(c => c[0]);
      const viaRoot = w.prisma.bankTransaction!.updateMany.mock.calls.map(c => c[0]);
      expect(viaTx.some(a => (a.data as { status?: string }).status === 'MATCHED')).toBe(true);
      expect(viaRoot.some(a => (a.data as { status?: string }).status === 'MATCHED')).toBe(false);
    });

    // guards: BR-BANK-034
    it('каса іншої валюти → 400, касової операції немає, рядок UNMATCHED', async () => {
      const w = await makeWorld();
      w.addRow();

      await expect(
        reconcile(w, { type: 'CASH_WITHDRAWAL', cashRegisterId: ID.cashUsd }),
      ).rejects.toMatchObject({
        status: 400,
        message: translateError('err.bankStatement.cashRegisterCurrencyMismatch', 'uk'),
      });

      expect(effectCalls(w)).toEqual(NO_EFFECTS);
      expect(w.row()).toMatchObject(FREE_ROW);
    });

    // Фіскальна каса без відкритої зміни: відмовляє сама CashService.createOperation.
    // guards: BR-BANK-034
    it('каса кинула (фіскальна без зміни) → та сама помилка; рядок не лишається MATCHED, операції немає', async () => {
      const w = await makeWorld();
      w.addRow();
      const shiftClosed = new BadRequestException('Відкрийте касову зміну');
      w.cash.createOperation.mockRejectedValueOnce(shiftClosed);

      await expect(reconcile(w, VALID.CASH_WITHDRAWAL)).rejects.toBe(shiftClosed);

      expect(w.row()).toMatchObject({ ...FREE_ROW, matchedAt: null, matchedBy: null });
      expect(w.db.rows('cashOperation')).toEqual([]);
    });

    // guards: BR-BANK-038
    it.each([
      ['чужої організації', ID.cashForeign],
      ['видалена', ID.cashDeleted],
      ['неіснуюча', '99999999-9999-4999-8999-999999999999'],
    ])('каса %s → 400, касової операції немає', async (_name, cashRegisterId) => {
      const w = await makeWorld();
      w.addRow();

      await expect(reconcile(w, { type: 'CASH_WITHDRAWAL', cashRegisterId })).rejects.toMatchObject(
        { status: 400 },
      );

      expect(effectCalls(w)).toEqual(NO_EFFECTS);
      expect(w.row()).toMatchObject(FREE_ROW);
    });
  });

  describe('EXPENSE — витрата за статтею', () => {
    // guards: BR-BANK-031
    it('стаття записана, контрагент довідковий; взаєморозрахунки й каса не змінюються', async () => {
      const w = await makeWorld();
      w.addRow();

      await reconcile(w, {
        type: 'EXPENSE',
        expenseCategoryId: ID.expense,
        counterpartyId: ID.supplier,
      });

      expect(w.row()).toMatchObject({
        status: 'MATCHED',
        matchedType: 'EXPENSE',
        expenseCategoryId: ID.expense,
        counterpartyId: ID.supplier,
      });
      expect(effectCalls(w)).toEqual(NO_EFFECTS);
      expect(w.db.rows('cashOperation')).toEqual([]);
    });

    // guards: BR-BANK-031
    it('без контрагента теж проходить — він необов’язковий', async () => {
      const w = await makeWorld();
      w.addRow();

      await reconcile(w, VALID.EXPENSE);

      expect(w.row()).toMatchObject({ status: 'MATCHED', counterpartyId: null });
    });

    // guards: BR-BANK-031, BR-BANK-038
    it.each([
      ['неактивна', ID.expenseInactive],
      ['типу INCOME', ID.expenseIncome],
      ['чужої організації', ID.expenseForeign],
      ['видалена', ID.expenseDeleted],
    ])('стаття %s → 400, рядок UNMATCHED, жодних ефектів', async (_name, expenseCategoryId) => {
      const w = await makeWorld();
      w.addRow();

      await expect(reconcile(w, { type: 'EXPENSE', expenseCategoryId })).rejects.toMatchObject({
        status: 400,
        message: translateError('err.bankStatement.expenseCategoryInvalid', 'uk'),
      });

      expect(effectCalls(w)).toEqual(NO_EFFECTS);
      expect(w.row()).toMatchObject(FREE_ROW);
    });

    // guards: BR-BANK-038
    it('довідковий контрагент чужої організації → 404, рядок UNMATCHED', async () => {
      const w = await makeWorld();
      w.addRow();

      await expect(
        reconcile(w, {
          type: 'EXPENSE',
          expenseCategoryId: ID.expense,
          counterpartyId: ID.cpForeign,
        }),
      ).rejects.toMatchObject({ status: 404 });

      expect(w.row()).toMatchObject(FREE_ROW);
    });
  });

  describe('PAYROLL — класифікація зарплатного платежу', () => {
    const periodWrites = (w: World) => [
      ...w.calls('payrollPeriod', 'update'),
      ...w.calls('payrollPeriod', 'updateMany'),
      ...w.calls('payrollLine', 'update'),
      ...w.calls('payrollLine', 'updateMany'),
    ];

    // guards: BR-BANK-032
    it.each([
      ['COMPUTED', ID.periodComputed],
      ['PAID', ID.periodPaid],
    ])(
      'період %s з працівником, у якого є рядок → MATCHED; статус періоду і paidAmount не змінено',
      async (status, payrollPeriodId) => {
        const w = await makeWorld();
        w.addRow();

        await reconcile(w, { type: 'PAYROLL', payrollPeriodId, employeeId: ID.employee });

        expect(w.row()).toMatchObject({
          status: 'MATCHED',
          matchedType: 'PAYROLL',
          payrollPeriodId,
          employeeId: ID.employee,
        });
        expect(periodWrites(w)).toEqual([]);
        expect(w.db.get('payrollPeriod', payrollPeriodId).status).toBe(status);
        expect(w.db.rows('payrollLine').every(l => Number(l.paidAmount) === 0)).toBe(true);
        expect(effectCalls(w)).toEqual(NO_EFFECTS);
      },
    );

    // guards: BR-BANK-032
    it('без працівника — рознесення на період загалом', async () => {
      const w = await makeWorld();
      w.addRow();

      await reconcile(w, VALID.PAYROLL);

      expect(w.row()).toMatchObject({
        status: 'MATCHED',
        payrollPeriodId: ID.periodComputed,
        employeeId: null,
      });
    });

    // guards: BR-BANK-032, BR-BANK-038
    it.each([
      ['DRAFT', ID.periodDraft],
      ['CANCELLED', ID.periodCancelled],
      ['чужої організації', ID.periodForeign],
      ['видалений', ID.periodDeleted],
    ])('період %s → 400, рядок UNMATCHED', async (_name, payrollPeriodId) => {
      const w = await makeWorld();
      w.addRow();

      await expect(reconcile(w, { type: 'PAYROLL', payrollPeriodId })).rejects.toMatchObject({
        status: 400,
        message: translateError('err.bankStatement.payrollPeriodInvalid', 'uk'),
      });

      expect(w.row()).toMatchObject(FREE_ROW);
      expect(periodWrites(w)).toEqual([]);
    });

    // guards: BR-BANK-032
    it('працівник без рядка в цьому періоді → 400, рядок UNMATCHED', async () => {
      const w = await makeWorld();
      w.addRow();

      await expect(
        reconcile(w, {
          type: 'PAYROLL',
          payrollPeriodId: ID.periodComputed,
          employeeId: ID.employeeNoLine,
        }),
      ).rejects.toMatchObject({
        status: 400,
        message: translateError('err.bankStatement.employeeNotInPeriod', 'uk'),
      });

      expect(w.row()).toMatchObject(FREE_ROW);
    });
  });

  describe('TRANSFER — переказ між власними рахунками', () => {
    // guards: BR-BANK-033
    it('інший власний рахунок → MATCHED; нічого не проводиться, парний рядок не створюється', async () => {
      const w = await makeWorld();
      w.addRow();

      await reconcile(w, VALID.TRANSFER);

      expect(w.row()).toMatchObject({
        status: 'MATCHED',
        matchedType: 'TRANSFER',
        transferBankAccountId: ID.account2,
      });
      expect(effectCalls(w)).toEqual(NO_EFFECTS);
      expect(w.db.rows('bankTransaction')).toHaveLength(1);
    });

    // guards: BR-BANK-033, BR-BANK-038
    it.each([
      ['той самий, що в рядку', ID.account],
      ['чужої організації', ID.accountForeign],
      ['видалений', ID.accountDeleted],
    ])('рахунок %s → 400, рядок UNMATCHED', async (_name, transferBankAccountId) => {
      const w = await makeWorld();
      w.addRow();

      await expect(reconcile(w, { type: 'TRANSFER', transferBankAccountId })).rejects.toMatchObject(
        {
          status: 400,
          message: translateError('err.bankStatement.transferAccountInvalid', 'uk'),
        },
      );

      expect(w.row()).toMatchObject(FREE_ROW);
      expect(effectCalls(w)).toEqual(NO_EFFECTS);
    });
  });
});
