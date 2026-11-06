import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { translateError } from '@sto/shared';
import { describe, it, expect } from 'vitest';
import type { ReconcileTransactionDto } from './bank-statement.dto';
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

// Аспект: вихідний платіж як оплата постачальнику — прив'язка до проведеної оплати, створення
// нової з рядка (одна транзакція, Bug #1023), список кандидатів для прив'язки.
// Правила BR-BANK-027, 028, 029 (+ 026, 038) — docs/objects/bank-statements.md.
//
// Написано ДО реалізації (2026-10-09) з контракту; 2026-11-06 нова оплата переписана на одну
// транзакцію: SupplierPaymentsService.prepareCreateAndConfirm(…, { rateDate }) до неї,
// createAndConfirmInTx(tx, prepared, userId, { originBankTransactionId }) у ній.
//
// Mutation-verify (кожна мутація мусить валити названі кейси):
//  · прив'язка: прибрати будь-яку з перевірок (status CONFIRMED, sourceType, bankAccountId, amount,
//    currencyId) → відповідний рядок «оплата … → 400»; не ловити P2002 → «унікальний індекс → 409»;
//  · прив'язка: покликати settlements.createTransaction → «нічого не проводиться»;
//  · нова: передати в оплату суму з dto / не передати bankAccountId рядка / documentDate = сьогодні /
//    без `{ rateDate }` / без `originBankTransactionId` → «створює і проводить оплату з даними рядка»;
//  · нова: `createAndConfirmInTx(this.prisma, …)` → «оплату створено й проведено, а запис посилання впав»;
//  · нова: прибрати `status: 'UNMATCHED'` з CAS → «рядок уже захопив інший запит»;
//  · кандидати: прибрати будь-яку умову відбору → «лише проведені банківські оплати…».

const MISMATCH = translateError('err.bankStatement.supplierPaymentMismatch', 'uk');

const LINK: ReconcileTransactionDto = { type: 'SUPPLIER_PAYMENT', supplierPaymentId: ID.sp };
const NEW: ReconcileTransactionDto = { type: 'SUPPLIER_PAYMENT', counterpartyId: ID.supplier };

const reconcile = (w: World, dto: ReconcileTransactionDto) =>
  w.service.reconcile(ORG, ID.tx, dto, USER);

describe('BankReconciliationService.reconcile — SUPPLIER_PAYMENT, прив’язка до наявної оплати', () => {
  // guards: BR-BANK-027
  it('проведена оплата з того самого рахунку на ту саму суму → рядок прив’язано; нічого не проводиться', async () => {
    const w = await makeWorld();
    w.addRow();
    w.db.seed('supplierPayment', supplierPaymentRow());

    await reconcile(w, LINK);

    expect(w.row()).toMatchObject({
      status: 'MATCHED',
      matchedType: 'SUPPLIER_PAYMENT',
      supplierPaymentId: ID.sp,
      // Контрагент рядка = постачальник оплати, а не з запиту.
      counterpartyId: ID.supplier,
    });
    // Борг постачальнику зменшено ще при проведенні оплати — другого проведення бути не може.
    expect(effectCalls(w)).toEqual(NO_EFFECTS);
    expect(w.db.get('supplierPayment', ID.sp).status).toBe('CONFIRMED');
  });

  // Посилання мусить лягти ТИМ САМИМ записом, що й статус: інакше між CAS і записом посилання
  // унікальний індекс supplierPaymentId нічого не стереже.
  // guards: BR-BANK-026, BR-BANK-027
  it('supplierPaymentId пишеться в data самого CAS-захоплення (status UNMATCHED → MATCHED)', async () => {
    const w = await makeWorld();
    w.addRow();
    w.db.seed('supplierPayment', supplierPaymentRow());

    await reconcile(w, LINK);

    const captures = w.statusWrites('MATCHED');
    expect(captures).toHaveLength(1);
    expect(captures[0]!.where).toMatchObject({ id: ID.tx, orgId: ORG, status: 'UNMATCHED' });
    expect(captures[0]!.data).toMatchObject({ status: 'MATCHED', supplierPaymentId: ID.sp });
  });

  // guards: BR-BANK-027
  it.each([
    ['ще чернетка (DRAFT)', { status: 'DRAFT' }],
    ['скасована (CANCELLED)', { status: 'CANCELLED' }],
    [
      'з каси, а не з банку',
      { sourceType: 'CASH_REGISTER', bankAccountId: null, cashRegisterId: ID.cashUah },
    ],
    ['з іншого банківського рахунку', { bankAccountId: ID.account2 }],
    ['на іншу суму (на копійку менше)', { amount: dec(ROW_AMOUNT - 0.01) }],
    ['в іншій валюті', { currencyId: ID.usd }],
  ])('оплата %s → 400, рядок UNMATCHED, нічого не проводиться', async (_name, over) => {
    const w = await makeWorld();
    w.addRow();
    w.db.seed('supplierPayment', supplierPaymentRow(over));

    await expect(reconcile(w, LINK)).rejects.toMatchObject({ status: 400, message: MISMATCH });

    expect(w.row()).toMatchObject(FREE_ROW);
    expect(effectCalls(w)).toEqual(NO_EFFECTS);
  });

  // guards: BR-BANK-027
  it('оплата вже прив’язана до іншого рядка → 409, цей рядок UNMATCHED, чужа прив’язка ціла', async () => {
    const w = await makeWorld();
    w.addRow();
    w.addRow({
      id: ID.tx2,
      externalId: 'ext-2',
      status: 'MATCHED',
      matchedType: 'SUPPLIER_PAYMENT',
      supplierPaymentId: ID.sp,
      counterpartyId: ID.supplier,
    });
    w.db.seed('supplierPayment', supplierPaymentRow());

    await expect(reconcile(w, LINK)).rejects.toMatchObject({ status: 409 });

    expect(w.row()).toMatchObject(FREE_ROW);
    expect(w.row(ID.tx2)).toMatchObject({ status: 'MATCHED', supplierPaymentId: ID.sp });
    expect(effectCalls(w)).toEqual(NO_EFFECTS);
  });

  // Дві одночасні прив'язки: попередня перевірка в обох пройшла, другу зупиняє унікальний індекс.
  // guards: BR-BANK-027
  it('унікальний індекс спрацював на записі (P2002) → 409, а не 500', async () => {
    const w = await makeWorld();
    w.addRow();
    w.db.seed('supplierPayment', supplierPaymentRow());
    const unique = () =>
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'fake',
        meta: { target: ['supplierPaymentId'] },
      });
    w.prisma.bankTransaction!.updateMany.mockRejectedValueOnce(unique());
    w.tx.bankTransaction!.updateMany.mockRejectedValueOnce(unique());

    await expect(reconcile(w, LINK)).rejects.toMatchObject({ status: 409 });

    expect(w.row()).toMatchObject(FREE_ROW);
    expect(effectCalls(w)).toEqual(NO_EFFECTS);
  });

  // guards: BR-BANK-038
  it.each([
    ['чужої організації', { orgId: OTHER_ORG }],
    ['видалена', { deletedAt: new Date('2026-10-01') }],
  ])('оплата %s → 404, рядок UNMATCHED', async (_name, over) => {
    const w = await makeWorld();
    w.addRow();
    w.db.seed('supplierPayment', supplierPaymentRow(over));

    await expect(reconcile(w, LINK)).rejects.toMatchObject({ status: 404 });

    expect(w.row()).toMatchObject(FREE_ROW);
    expect(effectCalls(w)).toEqual(NO_EFFECTS);
  });

  // guards: BR-BANK-038
  it('оплати з таким id немає → 404', async () => {
    const w = await makeWorld();
    w.addRow();

    await expect(reconcile(w, LINK)).rejects.toMatchObject({ status: 404 });

    expect(w.row()).toMatchObject(FREE_ROW);
  });
});

describe('BankReconciliationService.reconcile — SUPPLIER_PAYMENT, нова оплата з рядка', () => {
  // guards: BR-BANK-026, BR-BANK-028, BR-BANK-035
  it('створює і одразу проводить оплату з даними рядка: джерело, рахунок, сума, дата документа, курс на дату операції', async () => {
    const w = await makeWorld();
    w.addRow();
    const forged = {
      ...NEW,
      purchaseOrderId: ID.po,
      amount: 1,
      bankAccountId: ID.account2,
      documentDate: '2020-01-01',
    } as ReconcileTransactionDto;

    await reconcile(w, forged);

    expect(w.supplierPayments.prepareCreateAndConfirm).toHaveBeenCalledTimes(1);
    const [prepOrg, created, prepOpts] = w.supplierPayments.prepareCreateAndConfirm.mock.calls[0]!;
    expect(prepOrg).toBe(ORG);
    expect(created).toMatchObject({
      supplierId: ID.supplier,
      sourceType: 'BANK_ACCOUNT',
      bankAccountId: ID.account,
      amount: ROW_AMOUNT,
      purchaseOrderId: ID.po,
    });
    // Дата документа = календарна дата операції рядка (YYYY-MM-DD), не «сьогодні» і не з запиту.
    expect(String(created.documentDate).slice(0, 10)).toBe('2026-09-28');
    // Курс проведення — на дату операції рядка.
    expect((prepOpts as { rateDate?: Date } | undefined)?.rateDate).toEqual(OP_DATE);

    // Створення й проведення — у транзакції рознесення, з походженням «цей рядок» (BR-BANK-039).
    expect(w.supplierPayments.createAndConfirmInTx).toHaveBeenCalledTimes(1);
    const [client, prepared, user, opts] = w.supplierPayments.createAndConfirmInTx.mock.calls[0]!;
    expect(client).toBe(w.tx);
    expect(prepared).toBe(await w.supplierPayments.prepareCreateAndConfirm.mock.results[0]!.value);
    expect(user).toBe(USER);
    expect(opts).toEqual({ originBankTransactionId: ID.tx });

    expect(w.row()).toMatchObject({
      status: 'MATCHED',
      matchedType: 'SUPPLIER_PAYMENT',
      supplierPaymentId: ID.spNew,
      counterpartyId: ID.supplier,
    });
    expect(w.db.get('supplierPayment', ID.spNew)).toMatchObject({
      status: 'CONFIRMED',
      originBankTransactionId: ID.tx,
    });
    // Проведення йде ЛИШЕ через SupplierPaymentsService — сам сервіс виписки не проводить.
    expect(w.settlements.createTransaction).not.toHaveBeenCalled();
    expect(w.cash.createOperation).not.toHaveBeenCalled();
  });

  // guards: BR-BANK-028
  it('без замовлення — оплата створюється без purchaseOrderId', async () => {
    const w = await makeWorld();
    w.addRow();

    await reconcile(w, NEW);

    const created = w.supplierPayments.prepareCreateAndConfirm.mock.calls[0]![1];
    expect(created.purchaseOrderId ?? null).toBeNull();
    expect(w.row()).toMatchObject({ status: 'MATCHED', supplierPaymentId: ID.spNew });
  });

  // guards: BR-BANK-028
  it('контрагент лише з роллю клієнта → 400, рядок UNMATCHED, проведеної оплати немає', async () => {
    const w = await makeWorld();
    w.addRow();

    await expect(
      reconcile(w, { type: 'SUPPLIER_PAYMENT', counterpartyId: ID.client }),
    ).rejects.toMatchObject({ status: 400 });

    expect(w.row()).toMatchObject(FREE_ROW);
    expect(w.supplierPayments.createAndConfirmInTx).not.toHaveBeenCalled();
    expect(w.db.rows('supplierPayment')).toEqual([]);
  });

  // guards: BR-BANK-038
  it.each([
    ['чужої організації', ID.cpForeign],
    ['видалений', ID.cpDeleted],
  ])('постачальник %s → 404, рядок UNMATCHED', async (_name, counterpartyId) => {
    const w = await makeWorld();
    w.addRow();

    await expect(reconcile(w, { type: 'SUPPLIER_PAYMENT', counterpartyId })).rejects.toMatchObject({
      status: 404,
    });

    expect(w.row()).toMatchObject(FREE_ROW);
    expect(w.supplierPayments.createAndConfirmInTx).not.toHaveBeenCalled();
  });

  // guards: BR-BANK-028
  it('замовлення іншого постачальника → 400, рядок UNMATCHED, оплата не проведена', async () => {
    const w = await makeWorld();
    w.addRow();

    await expect(
      reconcile(w, { ...NEW, purchaseOrderId: ID.poOtherSupplier }),
    ).rejects.toMatchObject({ status: 400 });

    expect(w.row()).toMatchObject(FREE_ROW);
    expect(w.supplierPayments.createAndConfirmInTx).not.toHaveBeenCalled();
  });

  // Перевірки оплати (постачальник, замовлення, курс) — до транзакції: їх відмова рядка не чіпає.
  // guards: BR-BANK-028, BR-BANK-029
  it('перевірки оплати відмовили (немає курсу на дату) → рядок не захоплювався, транзакції не було', async () => {
    const w = await makeWorld();
    w.addRow();
    const refusal = new BadRequestException('Немає курсу на дату операції');
    w.supplierPayments.prepareCreateAndConfirm.mockRejectedValueOnce(refusal);

    await expect(reconcile(w, NEW)).rejects.toBe(refusal);

    expect(w.statusWrites('MATCHED')).toEqual([]);
    expect(w.prisma.$transaction).not.toHaveBeenCalled();
    expect(w.row()).toMatchObject({ ...FREE_ROW, matchedAt: null, matchedBy: null });
  });

  // Bug #1023: до 2026-11-06 — чернетка, посилання, проведення окремими комітами й ручний відкат.
  // guards: BR-BANK-029
  it('проведення відмовило в транзакції → оплати немає, рядок UNMATCHED без посилань, клієнт бачить початкову помилку', async () => {
    const w = await makeWorld();
    w.addRow();
    const original = new BadRequestException('Валюта оплати не збігається з валютою замовлення');
    w.supplierPayments.createAndConfirmInTx.mockRejectedValueOnce(original);

    await expect(reconcile(w, NEW)).rejects.toBe(original);

    expect(w.row()).toMatchObject({ ...FREE_ROW, matchedAt: null, matchedBy: null });
    expect(w.db.rows('supplierPayment')).toEqual([]);
  });

  // Збій ПІСЛЯ створення й проведення оплати: відкочується все, разом з оплатою. Старий порядок
  // (оплата власними комітами) лишив би проведену оплату без рядка — платити вдруге.
  // Mutation-verify: `createAndConfirmInTx(this.prisma, …)` замість `tx` → кейс червоніє.
  // guards: BR-BANK-029
  it('оплату створено й проведено, а запис посилання впав → немає ні оплати, ні захоплення рядка', async () => {
    const w = await makeWorld();
    w.addRow();
    const updateMany = w.tx.bankTransaction.updateMany;
    const real = updateMany.getMockImplementation()!;
    updateMany
      .mockImplementationOnce(real) // CAS-захоплення
      .mockImplementationOnce(() => Promise.reject(new Error('БД недоступна'))); // посилання

    await expect(reconcile(w, NEW)).rejects.toThrow('БД недоступна');

    expect(w.supplierPayments.createAndConfirmInTx).toHaveBeenCalledTimes(1);
    expect(w.db.rows('supplierPayment')).toEqual([]);
    expect(w.row()).toMatchObject({ ...FREE_ROW, matchedAt: null, matchedBy: null });
  });

  // guards: BR-BANK-029
  it('після невдалого проведення рядок можна рознести знову', async () => {
    const w = await makeWorld();
    w.addRow();
    w.supplierPayments.createAndConfirmInTx.mockRejectedValueOnce(new BadRequestException('збій'));
    await expect(reconcile(w, NEW)).rejects.toThrow('збій');

    await reconcile(w, NEW);

    const row = w.row();
    expect(row).toMatchObject({ status: 'MATCHED', matchedType: 'SUPPLIER_PAYMENT' });
    expect(w.db.rows('supplierPayment')).toHaveLength(1);
    expect(w.db.get('supplierPayment', row.supplierPaymentId as string).status).toBe('CONFIRMED');
  });

  // Рядок рознесли між читанням і транзакцією (інший запит): CAS програє, оплата не створюється.
  // guards: BR-BANK-026, BR-BANK-029
  it('рядок уже захопив інший запит → 409, оплата не створюється, чуже захоплення ціле', async () => {
    const w = await makeWorld();
    w.addRow();
    const foreignCapture = {
      status: 'MATCHED',
      matchedType: 'SUPPLIER_PAYMENT',
      counterpartyId: ID.supplier2,
      supplierPaymentId: null,
      matchedAt: new Date('2030-01-01T00:00:00.000Z'),
      matchedBy: '00000000-0000-4000-8000-000000000902',
    };
    const prepare = w.supplierPayments.prepareCreateAndConfirm.getMockImplementation()!;
    w.supplierPayments.prepareCreateAndConfirm.mockImplementationOnce(async (...args) => {
      const prepared = await prepare(...args);
      Object.assign(w.row(), foreignCapture);
      return prepared;
    });

    await expect(reconcile(w, NEW)).rejects.toMatchObject({ status: 409 });

    expect(w.supplierPayments.createAndConfirmInTx).not.toHaveBeenCalled();
    expect(w.db.rows('supplierPayment')).toEqual([]);
    expect(w.row()).toMatchObject(foreignCapture);
  });

  // Повтор на вже рознесеному рядку: 409 ДО перевірок нової оплати (замовлення, курс) — їхня
  // відмова від наслідків першого рознесення була б не про те. Mutation-verify: прибрати перевірку
  // `row.status !== 'UNMATCHED'` у reconcile → prepareCreateAndConfirm викликається.
  // guards: BR-BANK-026
  it('рядок уже рознесено до запиту → 409, перевірки нової оплати не запускаються', async () => {
    const w = await makeWorld();
    w.addRow({ status: 'MATCHED', matchedType: 'EXPENSE' });

    await expect(reconcile(w, NEW)).rejects.toMatchObject({ status: 409 });

    expect(w.supplierPayments.prepareCreateAndConfirm).not.toHaveBeenCalled();
    expect(w.supplierPayments.createAndConfirmInTx).not.toHaveBeenCalled();
    expect(w.db.rows('supplierPayment')).toEqual([]);
  });

  // Маршрут під ключем ідемпотентності: відповідь — з транзакції рознесення, а не після коміту.
  // guards: BR-BANK-029
  it('відповідь читається в транзакції рознесення', async () => {
    const w = await makeWorld();
    w.addRow();

    const res = await reconcile(w, NEW);

    expect(w.tx.bankTransaction.findFirstOrThrow).toHaveBeenCalledTimes(1);
    expect(w.prisma.bankTransaction.findFirstOrThrow).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      status: 'MATCHED',
      supplierPaymentId: ID.spNew,
      supplierPaymentNumber: 'ОПП-20261009-000007',
      supplierPaymentFromRow: true,
    });
  });
});

describe('BankReconciliationService.listSupplierPaymentCandidates', () => {
  // guards: BR-BANK-027
  it('лише проведені банківські оплати з того самого рахунку, на ту саму суму й валюту, ще не прив’язані', async () => {
    const w = await makeWorld();
    w.addRow();
    w.addRow({
      id: ID.tx2,
      externalId: 'ext-2',
      status: 'MATCHED',
      matchedType: 'SUPPLIER_PAYMENT',
      supplierPaymentId: 'sp-linked',
    });
    const other = (id: string, over: Record<string, unknown>) =>
      w.db.seed('supplierPayment', supplierPaymentRow({ id, number: `ОПП-${id}`, ...over }));
    w.db.seed('supplierPayment', supplierPaymentRow({ purchaseOrderId: ID.po }));
    other('sp-draft', { status: 'DRAFT' });
    other('sp-cancelled', { status: 'CANCELLED' });
    other('sp-cash', { sourceType: 'CASH_REGISTER', bankAccountId: null });
    other('sp-other-account', { bankAccountId: ID.account2 });
    other('sp-other-amount', { amount: dec(ROW_AMOUNT + 1) });
    other('sp-other-currency', { currencyId: ID.usd });
    other('sp-linked', {});
    other('sp-foreign', { orgId: OTHER_ORG });
    other('sp-deleted', { deletedAt: new Date('2026-10-01') });

    const res = await w.service.listSupplierPaymentCandidates(ORG, ID.tx);

    expect(res.map(c => c.id)).toEqual([ID.sp]);
    expect(res[0]).toMatchObject({
      id: ID.sp,
      number: 'ОПП-20260928-000001',
      documentDate: '2026-09-28',
      amount: ROW_AMOUNT,
      supplierId: ID.supplier,
      supplierName: 'Контрагент 31',
      purchaseOrderId: ID.po,
      purchaseOrderNumber: '4521',
    });
  });

  // guards: BR-BANK-038
  it.each([
    ['немає', {}],
    ['чужої організації', { orgId: OTHER_ORG }],
  ])('рядка %s → 404', async (name, over) => {
    const w = await makeWorld();
    if (name !== 'немає') w.addRow(over);
    w.db.seed('supplierPayment', supplierPaymentRow());

    await expect(w.service.listSupplierPaymentCandidates(ORG, ID.tx)).rejects.toMatchObject({
      status: 404,
    });
  });

  // guards: BR-BANK-027
  it('список нічого не пише і не проводить', async () => {
    const w = await makeWorld();
    w.addRow();
    w.db.seed('supplierPayment', supplierPaymentRow());

    await w.service.listSupplierPaymentCandidates(ORG, ID.tx);

    expect(effectCalls(w)).toEqual(NO_EFFECTS);
    expect(w.calls('bankTransaction', 'updateMany')).toEqual([]);
    expect(w.row()).toMatchObject(FREE_ROW);
  });
});
