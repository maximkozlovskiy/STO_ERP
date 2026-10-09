import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import { describe, it, expect } from 'vitest';
import { BANK_TX_OUT_MATCH_TYPES, type BankTxOutMatchType } from './bank-statement.dto';
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
  supplierPaymentRow,
  type World,
} from './bank-reconciliation.world.spec-fixture';

// Аспект: скасування рознесення — BankReconciliationService.unreconcile.
// Правила BR-BANK-039, 040 — docs/objects/bank-statements.md.
//
// Написано ДО реалізації (2026-10-09) з контракту: unreconcile(orgId, txId, { reason }, userId).
//
// Mutation-verify (кожна мутація мусить валити названі кейси):
//  · прибрати `status: 'MATCHED'` з where CAS → «повторне скасування → 409» і «нерознесений / ігнорований → 409»;
//  · не перевіряти `count === 0` → «CAS програв гонку → 409, зворотного запису немає»;
//  · не очищати будь-яке з посилань або matchedType → кейс «…без посилань і виду» для відповідного виду;
//  · не писати unmatchReason / unmatchedAt / unmatchedBy → той самий кейс;
//  · дозволити рядок із paymentId → «рознесений через match → 400»;
//  · CLIENT_REFUND: не робити REFUND_OUT_CANCEL / зробити REFUND_OUT → «одне сторно-проведення»;
//  · CASH_WITHDRAWAL: direction IN замість OUT або інша каса → «одна зворотна касова операція»;
//  · CASH_WITHDRAWAL: CAS поза транзакцією касової операції → «готівки не вистачає → рядок лишається MATCHED»;
//  · SUPPLIER_PAYMENT: покликати supplierPayments.cancel → «оплата лишається проведеною».

/** Хто скасовує — навмисно НЕ той, хто розносив (unmatchedBy ≠ matchedBy). */
const CANCELLER = '00000000-0000-4000-8000-000000000901';
const REASON = 'Помилково рознесено не на ту статтю';

/** Посилання, які лишає в рядку рознесення кожного виду. */
const LINKS: Record<BankTxOutMatchType, Record<string, unknown>> = {
  SUPPLIER_PAYMENT: { supplierPaymentId: ID.sp, counterpartyId: ID.supplier },
  CLIENT_REFUND: { counterpartyId: ID.client },
  EXPENSE: { expenseCategoryId: ID.expense, counterpartyId: ID.supplier },
  PAYROLL: { payrollPeriodId: ID.periodComputed, employeeId: ID.employee },
  TRANSFER: { transferBankAccountId: ID.account2 },
  CASH_WITHDRAWAL: { cashOperationId: ID.cashOp },
};

/** Рядок, рознесений через reconcile видом `type`, разом із тим, що рознесення створило. */
function arrangeMatched(w: World, type: BankTxOutMatchType, over: Record<string, unknown> = {}) {
  const row = w.addRow({
    status: 'MATCHED',
    matchedType: type,
    matchedAt: new Date('2026-10-03T10:00:00.000Z'),
    matchedBy: USER,
    ...LINKS[type],
    ...over,
  });
  if (type === 'SUPPLIER_PAYMENT') w.db.seed('supplierPayment', supplierPaymentRow());
  if (type === 'CASH_WITHDRAWAL') {
    w.db.seed('cashOperation', {
      id: ID.cashOp,
      orgId: ORG,
      cashRegisterId: ID.cashUah,
      cashShiftId: null,
      direction: 'IN',
      amount: row.amount,
      amountBase: row.amountBase,
      rateUsed: dec(1),
      reason: 'MANUAL_IN',
      documentType: 'BankTransaction',
      documentId: ID.tx,
      createdBy: USER,
      createdAt: new Date('2026-10-03T10:00:00.000Z'),
    });
  }
  if (type === 'CLIENT_REFUND') {
    w.db.seed('settlementTransaction', {
      id: w.db.nextId(),
      orgId: ORG,
      counterpartyId: ID.client,
      type: 'REFUND_OUT',
      amount: row.amount,
      currencyId: row.currencyId,
      amountBase: row.amountBase,
      rateUsed: row.rateUsed,
      documentType: 'BankTransaction',
      documentId: ID.tx,
      createdBy: USER,
      createdAt: new Date('2026-10-03T10:00:00.000Z'),
    });
  }
  return row;
}

const unreconcile = (w: World) => w.service.unreconcile(ORG, ID.tx, { reason: REASON }, CANCELLER);

describe('BankReconciliationService.unreconcile — скасування рознесення', () => {
  describe('стан рядка після скасування', () => {
    // guards: BR-BANK-039
    it.each(BANK_TX_OUT_MATCH_TYPES)(
      '%s: рядок повертається в UNMATCHED без посилань і виду; причина, час і користувач збережені',
      async type => {
        const w = await makeWorld();
        arrangeMatched(w, type);
        const before = Date.now();

        const res = await unreconcile(w);

        const row = w.row();
        expect(row).toMatchObject({
          ...FREE_ROW,
          unmatchReason: REASON,
          unmatchedBy: CANCELLER,
        });
        expect(row.unmatchedAt).toBeInstanceOf(Date);
        expect((row.unmatchedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
        expect(res).toMatchObject({ id: ID.tx, status: 'UNMATCHED', unmatchReason: REASON });
      },
    );

    // guards: BR-BANK-039
    it('перехід — CAS: updateMany з where {id, orgId, status: MATCHED}', async () => {
      const w = await makeWorld();
      arrangeMatched(w, 'EXPENSE');

      await unreconcile(w);

      const releases = w.statusWrites('UNMATCHED');
      expect(releases).toHaveLength(1);
      expect(releases[0]!.where).toMatchObject({ id: ID.tx, orgId: ORG, status: 'MATCHED' });
    });

    // guards: BR-BANK-039
    it('TRANSFER на ВХІДНОМУ рядку теж скасовується (його розносили через reconcile)', async () => {
      const w = await makeWorld();
      arrangeMatched(w, 'TRANSFER', { direction: 'IN' });

      await unreconcile(w);

      expect(w.row()).toMatchObject({ ...FREE_ROW, unmatchReason: REASON });
    });

    // Форма запису аудиту контрактом не задана: досить, що подію записано (через AuditService
    // або напряму в auditEvent).
    // guards: BR-BANK-039
    it('скасування лишає запис у журналі аудиту', async () => {
      const w = await makeWorld();
      arrangeMatched(w, 'EXPENSE');

      await unreconcile(w);

      const audited = w.audit.record.mock.calls.length + w.calls('auditEvent', 'create').length;
      expect(audited).toBeGreaterThan(0);
    });
  });

  describe('що скасувати не можна', () => {
    // guards: BR-BANK-040
    it('вхідний рядок, рознесений через match (є paymentId) → 400, рядок і платіж не чіпаються', async () => {
      const w = await makeWorld();
      w.addRow({
        direction: 'IN',
        status: 'MATCHED',
        matchedType: 'SERVICE',
        counterpartyId: ID.client,
        paymentId: '77777777-7777-4777-8777-777777777777',
      });

      await expect(unreconcile(w)).rejects.toMatchObject({
        status: 400,
        message: translateError('err.bankStatement.unmatchIncomingUnsupported', 'uk'),
      });

      expect(w.row()).toMatchObject({
        status: 'MATCHED',
        matchedType: 'SERVICE',
        counterpartyId: ID.client,
        paymentId: '77777777-7777-4777-8777-777777777777',
        unmatchReason: null,
      });
      expect(effectCalls(w)).toEqual(NO_EFFECTS);
    });

    // guards: BR-BANK-040
    it.each([
      ['нерознесений', { status: 'UNMATCHED' }],
      ['ігнорований', { status: 'IGNORED', ignoreReason: 'комісія банку' }],
    ])('%s рядок → 409, нічого не змінено', async (_name, over) => {
      const w = await makeWorld();
      w.addRow(over);

      await expect(unreconcile(w)).rejects.toMatchObject({ status: 409 });

      expect(w.row()).toMatchObject({
        status: over.status,
        unmatchReason: null,
        unmatchedAt: null,
      });
      expect(effectCalls(w)).toEqual(NO_EFFECTS);
    });

    // guards: BR-BANK-038, BR-BANK-040
    it.each([
      ['немає', null],
      ['чужої організації', { orgId: OTHER_ORG }],
      ['видалено', { deletedAt: new Date('2026-10-01') }],
    ])('рядка %s → 404, без ефектів', async (_name, over) => {
      const w = await makeWorld();
      if (over) arrangeMatched(w, 'CLIENT_REFUND', over);

      await expect(unreconcile(w)).rejects.toMatchObject({ status: 404 });

      expect(effectCalls(w)).toEqual(NO_EFFECTS);
      expect(w.db.rows('bankTransaction').every(r => r.unmatchReason === null)).toBe(true);
    });

    // guards: BR-BANK-040
    it.each(['CLIENT_REFUND', 'CASH_WITHDRAWAL', 'EXPENSE'] as const)(
      'повторне скасування, вид %s → 409 без другого зворотного запису',
      async type => {
        const w = await makeWorld();
        arrangeMatched(w, type);

        await unreconcile(w);
        const afterFirst = effectCalls(w);
        await expect(unreconcile(w)).rejects.toMatchObject({ status: 409 });

        expect(effectCalls(w)).toEqual(afterFirst);
      },
    );

    // Одночасна спроба: рядок ще MATCHED на момент читання, але CAS уже програв (count = 0).
    // guards: BR-BANK-039, BR-BANK-040
    it.each(['CLIENT_REFUND', 'CASH_WITHDRAWAL'] as const)(
      'CAS програв гонку, вид %s → 409, зворотного запису немає',
      async type => {
        const w = await makeWorld();
        arrangeMatched(w, type);
        w.loseNextCas();

        await expect(unreconcile(w)).rejects.toMatchObject({ status: 409 });

        expect(effectCalls(w)).toEqual(NO_EFFECTS);
      },
    );
  });

  describe('наслідок залежить від виду', () => {
    // «Та сама сума в базовій валюті, що й початкове» досягається одним із двох способів, і обидва
    // правильні: (а) сума й валюта рядка з курсом на ту саму дату операції; (б) базова сума
    // початкового проведення без валюти (курс 1). Рядок у доларах розрізняє їх: 200 USD = 8300 UAH.
    // guards: BR-BANK-039
    it('CLIENT_REFUND: одне сторно-проведення REFUND_OUT_CANCEL на ту саму базову суму, в транзакції рядка', async () => {
      const w = await makeWorld();
      arrangeMatched(w, 'CLIENT_REFUND', {
        bankAccountId: ID.accountUsd,
        currencyId: ID.usd,
        amount: dec(200),
        amountBase: dec(8300),
        rateUsed: dec(41.5),
      });

      await unreconcile(w);

      expect(w.settlements.createTransaction).toHaveBeenCalledTimes(1);
      const [orgArg, posting, txArg] = w.settlements.createTransaction.mock.calls[0]!;
      expect(orgArg).toBe(ORG);
      expect(posting).toMatchObject({
        counterpartyId: ID.client,
        type: 'REFUND_OUT_CANCEL',
        documentType: 'BankTransaction',
        documentId: ID.tx,
      });
      const inRowCurrency =
        posting.currencyId === ID.usd &&
        Number(posting.amount) === 200 &&
        posting.date instanceof Date &&
        posting.date.getTime() === OP_DATE.getTime();
      const inBaseCurrency =
        (posting.currencyId == null || posting.currencyId === ID.uah) &&
        Number(posting.amount) === 8300;
      expect({ inRowCurrency, inBaseCurrency }).not.toEqual({
        inRowCurrency: false,
        inBaseCurrency: false,
      });
      expect(txArg).toBe(w.tx);
      expect({ ...effectCalls(w), 'settlements.createTransaction': 0 }).toEqual(NO_EFFECTS);
    });

    // guards: BR-BANK-039
    it('CLIENT_REFUND: сторно впало → помилка пробрасується, рядок лишається MATCHED', async () => {
      const w = await makeWorld();
      arrangeMatched(w, 'CLIENT_REFUND');
      w.settlements.createTransaction.mockRejectedValueOnce(new BadRequestException('збій сторно'));

      await expect(unreconcile(w)).rejects.toThrow('збій сторно');

      expect(w.row()).toMatchObject({
        status: 'MATCHED',
        matchedType: 'CLIENT_REFUND',
        counterpartyId: ID.client,
        unmatchReason: null,
      });
    });

    // guards: BR-BANK-039
    it('CASH_WITHDRAWAL: одна зворотна касова операція OUT / MANUAL_OUT на ту саму суму в ту саму касу, в транзакції рядка', async () => {
      const w = await makeWorld();
      arrangeMatched(w, 'CASH_WITHDRAWAL');

      await unreconcile(w);

      expect(w.cash.createOperation).toHaveBeenCalledTimes(1);
      const [orgArg, input, txArg] = w.cash.createOperation.mock.calls[0]!;
      expect(orgArg).toBe(ORG);
      expect(input).toMatchObject({
        cashRegisterId: ID.cashUah,
        direction: 'OUT',
        reason: 'MANUAL_OUT',
        amount: ROW_AMOUNT,
      });
      expect(txArg).toBe(w.tx);
      expect({ ...effectCalls(w), 'cash.createOperation': 0 }).toEqual(NO_EFFECTS);
    });

    // Готівку з каси вже витратили: CashService.createOperation відмовляє (овердрафт).
    // guards: BR-BANK-039
    it('CASH_WITHDRAWAL: готівки в касі не вистачає → та сама помилка, рядок лишається MATCHED з касовою операцією', async () => {
      const w = await makeWorld();
      arrangeMatched(w, 'CASH_WITHDRAWAL');
      const overdraft = new BadRequestException('Недостатньо готівки в касі');
      w.cash.createOperation.mockRejectedValueOnce(overdraft);

      await expect(unreconcile(w)).rejects.toBe(overdraft);

      expect(w.row()).toMatchObject({
        status: 'MATCHED',
        matchedType: 'CASH_WITHDRAWAL',
        cashOperationId: ID.cashOp,
        unmatchReason: null,
        unmatchedAt: null,
      });
      expect(w.db.rows('cashOperation')).toHaveLength(1);
    });

    // guards: BR-BANK-039
    it('SUPPLIER_PAYMENT: рядок відв’язано, оплата постачальнику лишається проведеною — жодного сторно', async () => {
      const w = await makeWorld();
      arrangeMatched(w, 'SUPPLIER_PAYMENT');

      await unreconcile(w);

      expect(effectCalls(w)).toEqual(NO_EFFECTS);
      expect(w.db.get('supplierPayment', ID.sp)).toMatchObject({
        status: 'CONFIRMED',
        deletedAt: null,
      });
      expect(w.row().supplierPaymentId).toBeNull();
    });

    // guards: BR-BANK-039
    it.each(['EXPENSE', 'PAYROLL', 'TRANSFER'] as const)(
      '%s: лише знімається класифікація — жодних проведень, каси й документів',
      async type => {
        const w = await makeWorld();
        arrangeMatched(w, type);

        await unreconcile(w);

        expect(effectCalls(w)).toEqual(NO_EFFECTS);
        expect(w.db.rows('cashOperation')).toEqual([]);
        expect(w.db.get('payrollPeriod', ID.periodComputed).status).toBe('COMPUTED');
      },
    );
  });
});
