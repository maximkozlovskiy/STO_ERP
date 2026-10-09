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
// нової з рядка, відкат невдалого проведення, список кандидатів для прив'язки.
// Правила BR-BANK-027, 028, 029 (+ 026, 038) — docs/objects/bank-statements.md.
//
// Написано ДО реалізації (2026-10-09) з контракту: reconcile(orgId, txId, dto, userId),
// listSupplierPaymentCandidates(orgId, txId), SupplierPaymentsService.create / confirm(…, { rateDate }) / cancel.
//
// Mutation-verify (кожна мутація мусить валити названі кейси):
//  · прив'язка: прибрати будь-яку з перевірок (status CONFIRMED, sourceType, bankAccountId, amount,
//    currencyId) → відповідний рядок «оплата … → 400»; не ловити P2002 → «унікальний індекс → 409»;
//  · прив'язка: покликати supplierPayments.confirm або settlements.createTransaction → «нічого не проводиться»;
//  · нова: передати в create суму з dto / не передати bankAccountId рядка / documentDate = сьогодні →
//    «створює і проводить оплату з даними рядка»; не передати `{ rateDate }` у confirm → той самий кейс;
//  · нова: прибрати cancel у catch → «проведення впало → чернетку скасовано»; не повертати рядок
//    в UNMATCHED або не чистити supplierPaymentId → той самий кейс і «можна рознести знову»;
//  · нова: прибрати `matchedAt: capturedAt` із where запису посилання → «…захопили знову іншим запитом»;
//    із where відкату → «проведення впало, а рядок уже захоплено іншим запитом»;
//  · нова: звільняти рядок, коли cancel відмовив для ПРОВЕДЕНОЇ оплати → «проведення закомічено, але confirm кинув»;
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

    expect(w.supplierPayments.create).toHaveBeenCalledTimes(1);
    const [createOrg, created, createUser] = w.supplierPayments.create.mock.calls[0]!;
    expect(createOrg).toBe(ORG);
    expect(createUser).toBe(USER);
    expect(created).toMatchObject({
      supplierId: ID.supplier,
      sourceType: 'BANK_ACCOUNT',
      bankAccountId: ID.account,
      amount: ROW_AMOUNT,
      purchaseOrderId: ID.po,
    });
    // Дата документа = календарна дата операції рядка (YYYY-MM-DD), не «сьогодні» і не з запиту.
    expect(String(created.documentDate).slice(0, 10)).toBe('2026-09-28');

    expect(w.supplierPayments.confirm).toHaveBeenCalledTimes(1);
    const [confirmOrg, confirmedId, confirmUser, opts] = w.supplierPayments.confirm.mock.calls[0]!;
    expect(confirmOrg).toBe(ORG);
    expect(confirmedId).toBe(ID.spNew);
    expect(confirmUser).toBe(USER);
    // Курс проведення — на дату операції рядка.
    expect((opts as { rateDate?: Date } | undefined)?.rateDate).toEqual(OP_DATE);

    expect(w.row()).toMatchObject({
      status: 'MATCHED',
      matchedType: 'SUPPLIER_PAYMENT',
      supplierPaymentId: ID.spNew,
      counterpartyId: ID.supplier,
    });
    expect(w.db.get('supplierPayment', ID.spNew).status).toBe('CONFIRMED');
    // Проведення йде ЛИШЕ через SupplierPaymentsService.confirm — сам сервіс виписки не проводить.
    expect(w.settlements.createTransaction).not.toHaveBeenCalled();
    expect(w.cash.createOperation).not.toHaveBeenCalled();
    expect(w.supplierPayments.cancel).not.toHaveBeenCalled();
  });

  // guards: BR-BANK-028
  it('без замовлення — оплата створюється без purchaseOrderId', async () => {
    const w = await makeWorld();
    w.addRow();

    await reconcile(w, NEW);

    const created = w.supplierPayments.create.mock.calls[0]![1];
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
    expect(w.supplierPayments.confirm).not.toHaveBeenCalled();
    expect(w.db.rows('supplierPayment').filter(p => p.status === 'CONFIRMED')).toEqual([]);
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
    expect(w.supplierPayments.confirm).not.toHaveBeenCalled();
  });

  // guards: BR-BANK-028
  it('замовлення іншого постачальника → 400, рядок UNMATCHED, оплата не проведена', async () => {
    const w = await makeWorld();
    w.addRow();

    await expect(
      reconcile(w, { ...NEW, purchaseOrderId: ID.poOtherSupplier }),
    ).rejects.toMatchObject({ status: 400 });

    expect(w.row()).toMatchObject(FREE_ROW);
    expect(w.supplierPayments.confirm).not.toHaveBeenCalled();
  });

  // guards: BR-BANK-029
  it('проведення впало → чернетку скасовано, рядок знову UNMATCHED без посилань, клієнт бачить початкову помилку', async () => {
    const w = await makeWorld();
    w.addRow();
    const original = new BadRequestException('Валюта оплати не збігається з валютою замовлення');
    w.supplierPayments.confirm.mockRejectedValueOnce(original);

    await expect(reconcile(w, NEW)).rejects.toBe(original);

    expect(w.supplierPayments.cancel).toHaveBeenCalledTimes(1);
    const [cancelOrg, cancelledId] = w.supplierPayments.cancel.mock.calls[0]!;
    expect(cancelOrg).toBe(ORG);
    expect(cancelledId).toBe(ID.spNew);
    expect(w.row()).toMatchObject({ ...FREE_ROW, matchedAt: null, matchedBy: null });
    expect(w.db.get('supplierPayment', ID.spNew).status).toBe('CANCELLED');
  });

  // guards: BR-BANK-029
  it('після невдалого проведення рядок можна рознести знову', async () => {
    const w = await makeWorld();
    w.addRow();
    w.supplierPayments.confirm.mockRejectedValueOnce(new BadRequestException('збій'));
    await expect(reconcile(w, NEW)).rejects.toThrow('збій');

    await reconcile(w, NEW);

    const row = w.row();
    expect(row).toMatchObject({ status: 'MATCHED', matchedType: 'SUPPLIER_PAYMENT' });
    expect(row.supplierPaymentId).not.toBe(ID.spNew);
    expect(w.db.get('supplierPayment', row.supplierPaymentId as string).status).toBe('CONFIRMED');
  });

  // guards: BR-BANK-029
  it('навіть якщо скасування чернетки теж упало — рядок звільнено і клієнт бачить ПОЧАТКОВУ помилку', async () => {
    const w = await makeWorld();
    w.addRow();
    const original = new BadRequestException('Немає курсу на дату операції');
    w.supplierPayments.confirm.mockRejectedValueOnce(original);
    w.supplierPayments.cancel.mockRejectedValueOnce(new Error('cancel теж упав'));

    await expect(reconcile(w, NEW)).rejects.toBe(original);

    expect(w.row()).toMatchObject(FREE_ROW);
  });

  // guards: BR-BANK-029
  it('створення чернетки впало → рядок звільнено; скасовувати нічого, проведення не було', async () => {
    const w = await makeWorld();
    w.addRow();
    const original = new BadRequestException('Не вдалося видати номер документа');
    w.supplierPayments.create.mockRejectedValueOnce(original);

    await expect(reconcile(w, NEW)).rejects.toBe(original);

    expect(w.row()).toMatchObject({ ...FREE_ROW, matchedAt: null, matchedBy: null });
    expect(w.supplierPayments.cancel).not.toHaveBeenCalled();
    expect(w.supplierPayments.confirm).not.toHaveBeenCalled();
  });

  // `confirm` закомітив свою транзакцію і впав уже на читанні відповіді: оплата ПРОВЕДЕНА.
  // Звільнений рядок дозволив би заплатити постачальнику вдруге.
  // guards: BR-BANK-029
  it('проведення закомічено, але confirm кинув → рядок лишається MATCHED з посиланням на проведену оплату', async () => {
    const w = await makeWorld();
    w.addRow();
    const original = new Error('з’єднання обірвалось на читанні відповіді');
    w.supplierPayments.confirm.mockImplementationOnce(async (_orgId: string, id: string) => {
      w.db.get('supplierPayment', id).status = 'CONFIRMED';
      throw original;
    });

    await expect(reconcile(w, NEW)).rejects.toBe(original);

    expect(w.db.get('supplierPayment', ID.spNew).status).toBe('CONFIRMED');
    expect(w.row()).toMatchObject({
      status: 'MATCHED',
      matchedType: 'SUPPLIER_PAYMENT',
      counterpartyId: ID.supplier,
      supplierPaymentId: ID.spNew,
    });
  });

  // Скасування впало, і стан оплати з'ясувати не вдалося — безпечний бік: рядок не звільняється.
  // guards: BR-BANK-029
  it('скасування чернетки впало і стан оплати невідомий → рядок лишається MATCHED з посиланням', async () => {
    const w = await makeWorld();
    w.addRow();
    w.supplierPayments.confirm.mockRejectedValueOnce(new Error('БД недоступна'));
    w.supplierPayments.cancel.mockRejectedValueOnce(new Error('БД недоступна'));
    w.prisma.supplierPayment.findFirst.mockRejectedValueOnce(new Error('БД недоступна'));

    await expect(reconcile(w, NEW)).rejects.toThrow('БД недоступна');

    expect(w.row()).toMatchObject({ status: 'MATCHED', supplierPaymentId: ID.spNew });
  });

  // Кроки нової оплати йдуть НЕ однією транзакцією. Поки створювалась чернетка, рядок звільнили
  // (скасування рознесення) — проводити оплату для вже нічийного рядка не можна.
  // guards: BR-BANK-026, BR-BANK-029
  it('рядок звільнили, поки створювалась чернетка → 409, оплата не проводиться, чернетку скасовано', async () => {
    const w = await makeWorld();
    w.addRow();
    const create = w.supplierPayments.create.getMockImplementation()!;
    w.supplierPayments.create.mockImplementationOnce(async (...args) => {
      const draft = await create(...args);
      Object.assign(w.row(), { ...FREE_ROW, matchedAt: null, matchedBy: null });
      return draft;
    });

    await expect(reconcile(w, NEW)).rejects.toMatchObject({ status: 409 });

    expect(w.supplierPayments.confirm).not.toHaveBeenCalled();
    expect(w.db.get('supplierPayment', ID.spNew).status).toBe('CANCELLED');
    expect(w.row()).toMatchObject(FREE_ROW);
  });

  // Те саме, але рядок устигли ще й захопити ЗНОВУ тим самим видом (інший запит, інший
  // постачальник): статус і вид збігаються з нашими, посилання ще порожнє. Без мітки захоплення
  // наша чернетка прив'язалась би до чужого рознесення й провелась би.
  // guards: BR-BANK-026, BR-BANK-029
  it('рядок звільнили й захопили знову іншим запитом → 409, наша оплата не проводиться, чуже захоплення ціле', async () => {
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
    const create = w.supplierPayments.create.getMockImplementation()!;
    w.supplierPayments.create.mockImplementationOnce(async (...args) => {
      const draft = await create(...args);
      Object.assign(w.row(), foreignCapture);
      return draft;
    });

    await expect(reconcile(w, NEW)).rejects.toMatchObject({ status: 409 });

    expect(w.supplierPayments.confirm).not.toHaveBeenCalled();
    expect(w.db.get('supplierPayment', ID.spNew).status).toBe('CANCELLED');
    expect(w.row()).toMatchObject(foreignCapture);
  });

  // Проведення впало, а рядок тим часом уже чужий: відкат не має його звільняти.
  // guards: BR-BANK-029
  it('проведення впало, а рядок уже захоплено іншим запитом → відкат чужого захоплення не чіпає', async () => {
    const w = await makeWorld();
    w.addRow();
    const foreignCapture = {
      status: 'MATCHED',
      matchedType: 'SUPPLIER_PAYMENT',
      counterpartyId: ID.supplier2,
      matchedAt: new Date('2030-01-01T00:00:00.000Z'),
    };
    w.supplierPayments.confirm.mockImplementationOnce(async () => {
      // Чуже захоплення успадкувало б наше посилання лише в підробці — у житті воно має своє;
      // для відкату важить мітка: рядок більше не наш.
      Object.assign(w.row(), foreignCapture);
      throw new BadRequestException('збій проведення');
    });

    await expect(reconcile(w, NEW)).rejects.toThrow('збій проведення');

    expect(w.row()).toMatchObject(foreignCapture);
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
