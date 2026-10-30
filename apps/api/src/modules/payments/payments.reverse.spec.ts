/**
 * Сторно оплати контрагента з каси (BR-CASH-024) — що відкочує `PaymentsService.reverse`:
 *
 *   • оплата позначається сторнованою один раз (CAS на `reversedAt`): повтор → 400;
 *   • проводка `PAYMENT_CANCEL` або `PREPAYMENT_CANCEL` (+1) — за типом проводки оригіналу, на ту
 *     саму суму, з курсом оригіналу;
 *   • «сплачено» рахунку й наряду, які підняла ця оплата, мінус сума (не нижче 0); статус рахунку
 *     → «Частково оплачено» / «Виставлено», наряду «Оплачено» → «Виставлено» (внутрішнім записом);
 *   • чек, відхилений ПРРО (FAILED) → SKIPPED; бонуси — `LoyaltyService.reverseEarn`;
 *   • валютна оплата — за курсом оплати; курсова різниця повної оплати відкочується, коли документ
 *     перестає бути сплаченим повністю (BR-PAY-028);
 *   • відмови: чек пробито (DONE), чек ще в черзі ПРРО (QUEUED, BR-PAY-029), наряд в архіві,
 *     рахунок скасовано.
 *
 * Метод внутрішній — кличе його каса (`CashDeskService.reverse`) зі СВОЄЮ транзакцією. Тому
 * кореневий prisma тут на запис заборонений: усе, що змінює дані, мусить іти через переданий tx.
 *
 * Написано зі специфікації ДО коду. Контракт (план 2026-10-14):
 *   PaymentsService.reverse(orgId, paymentId, { cashOperationId, reason, userId }, tx)
 *   LoyaltyService.reverseEarn(orgId, paymentId, tx?)
 *   проводка: documentType 'Payment', documentId = id оплати, conversion — з проводки оригіналу.
 *
 * Довідники — таблиці в пам'яті (`memoryTable`): скільки запитів і в якому порядку зробить сервіс,
 * з правила не випливає, а `where` вони застосовують по-справжньому.
 */
import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  CLIENT,
  ORG,
  OTHER_ORG,
  PAY,
  STORNO_OP,
  USER,
  WO,
  makeHarness,
  staleRead,
} from './payments.reverse.spec-fixture';

describe('PaymentsService.reverse — оплата сторнується один раз', () => {
  // guards: BR-CASH-024
  it('оплата отримує reversedAt і reversalCashOperationId = рядок сторно', async () => {
    const h = makeHarness();
    await h.reverse();
    expect(h.payment.reversedAt).toBeInstanceOf(Date);
    expect(h.payment.reversalCashOperationId).toBe(STORNO_OP);
  });

  // guards: BR-CASH-024
  it('повторне сторно тієї самої оплати → 400; другої проводки немає', async () => {
    const h = makeHarness();
    await h.reverse();
    await expect(h.reverse()).rejects.toThrow(BadRequestException);
    expect(h.settlementRows.filter(r => r.type === 'PAYMENT_CANCEL')).toHaveLength(1);
  });

  // Дві каси сторнують одну оплату разом: обидві прочитали reversedAt = null. Зупиняє лише
  // умовний запис (CAS) `where reversedAt: null` — перевірка прочитаного значення тут сліпа.
  // guards: BR-CASH-024
  it('CAS: прочитано «не сторновано», а запис уже сторновано паралельно → 400', async () => {
    const h = makeHarness();
    h.payment.reversedAt = new Date('2026-10-14T10:00:00.000Z');
    h.payment.reversalCashOperationId = 'f0000000-0000-4000-8000-00000000000f';
    const stale = () =>
      Promise.resolve({ ...h.payment, reversedAt: null, reversalCashOperationId: null });
    h.tables.payment.findFirst.mockImplementation(stale);
    h.tables.payment.findUnique.mockImplementation(stale);
    h.tables.payment.findFirstOrThrow.mockImplementation(stale);
    h.tables.payment.findUniqueOrThrow.mockImplementation(stale);

    await expect(h.reverse()).rejects.toThrow(BadRequestException);
    // Перше сторно лишилось чинним — його посилання не перезаписано.
    expect(h.payment.reversalCashOperationId).toBe('f0000000-0000-4000-8000-00000000000f');
  });

  // guards: BR-CASH-024
  it('оплата іншої організації не сторнується: помилка, рядок оплати не змінено', async () => {
    const h = makeHarness();
    await expect(h.reverse(OTHER_ORG)).rejects.toThrow();
    expect(h.payment.reversedAt).toBeNull();
    expect(h.settlementRows).toEqual([]);
  });
});

describe('PaymentsService.reverse — проводка сторно', () => {
  // guards: BR-CASH-024
  it('оригінал PAYMENT → PAYMENT_CANCEL на ту саму суму, з контрагентом, курсом оригіналу і в tx каси', async () => {
    const h = makeHarness();
    await h.reverse();
    expect(h.settlementRows).toHaveLength(1);
    const posting = h.settlementRows[0];
    expect(posting).toMatchObject({
      orgId: ORG,
      counterpartyId: CLIENT,
      // BR-CASH-024: проводка сторно посилається на РЯДОК СТОРНО каси (як повернення, BR-CASH-025);
      // оплату знаходять через нього: reversalOfId → оригінал → documentId.
      type: 'PAYMENT_CANCEL',
      documentType: 'CashOperation',
      documentId: STORNO_OP,
    });
    expect(Number(posting.amount)).toBe(400);
    const conversion = posting.conversion as { rateUsed: unknown; amountBase: unknown };
    expect(Number(conversion.rateUsed)).toBe(1);
    expect(Number(conversion.amountBase)).toBe(400);
    expect(posting.__tx).toBe(h.tx);
  });

  // guards: BR-CASH-024
  it('оригінал PREPAYMENT (аванс без рахунку й наряду) → PREPAYMENT_CANCEL', async () => {
    const h = makeHarness({
      payment: { workOrderId: null, invoiceId: null, amount: 2500.5, amountBase: 2500.5 },
      invoice: null,
      workOrder: null,
      postingType: 'PREPAYMENT',
    });
    await h.reverse();
    expect(h.settlementRows.map(r => r.type)).toEqual(['PREPAYMENT_CANCEL']);
    expect(Number(h.settlementRows[0].amount)).toBe(2500.5);
  });
});

describe('PaymentsService.reverse — «сплачено» рахунку', () => {
  // guards: BR-CASH-024
  it.each([
    [
      '«Оплачено» 1000, сторно 400 → 600, «Частково оплачено»',
      'PAID',
      1000,
      400,
      600,
      'PARTIALLY_PAID',
    ],
    ['«Оплачено» 1000, сторно 1000 → 0, «Виставлено»', 'PAID', 1000, 1000, 0, 'SENT'],
    [
      '«Частково оплачено» 400, сторно 400 → 0, «Виставлено»',
      'PARTIALLY_PAID',
      400,
      400,
      0,
      'SENT',
    ],
    [
      '«Частково оплачено» 700, сторно 0.01 → 699.99',
      'PARTIALLY_PAID',
      700,
      0.01,
      699.99,
      'PARTIALLY_PAID',
    ],
  ])('%s', async (_n, status, paid, amount, expectedPaid, expectedStatus) => {
    const h = makeHarness({
      payment: { amount, amountBase: amount, workOrderId: null },
      invoice: { status, paidAmount: paid },
    });
    await h.reverse();
    expect(Number(h.invoice?.paidAmount)).toBeCloseTo(expectedPaid, 2);
    expect(h.invoice?.status).toBe(expectedStatus);
  });

  // guards: BR-CASH-024
  it('«сплачено» не йде нижче нуля (розійшлось раніше: 300 при оплаті 400) → 0, «Виставлено»', async () => {
    const h = makeHarness({
      payment: { amount: 400, amountBase: 400, workOrderId: null },
      invoice: { status: 'PARTIALLY_PAID', paidAmount: 300 },
    });
    await h.reverse();
    expect(Number(h.invoice?.paidAmount)).toBe(0);
    expect(h.invoice?.status).toBe('SENT');
  });

  // guards: BR-CASH-024
  it('рахунок скасовано → 400 «Рахунок оплати скасовано»', async () => {
    // Оплата рахунку БЕЗ наряду: рахунок — її єдиний документ.
    const h = makeHarness({
      payment: { workOrderId: null },
      invoice: { status: 'CANCELLED', workOrderId: null },
    });
    const call = h.reverse();
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/Рахунок оплати скасовано/);
  });

  // Оплата наряду: рахунок наряду — лише дзеркало (BR-INV-018); скасований рахунок сторно не
  // блокує, а «сплачено» йде з наряду.
  // guards: BR-CASH-024, BR-INV-018
  it('оплата наряду, її рахунок скасовано → сторно проходить: наряд мінус сума, скасований рахунок не чіпається', async () => {
    const h = makeHarness({ invoice: { status: 'CANCELLED', paidAmount: 1000 } });
    await h.reverse();
    expect(Number(h.workOrder?.paidAmount)).toBe(600);
    expect(h.workOrder?.status).toBe('INVOICED');
    expect(h.invoice).toMatchObject({ status: 'CANCELLED', paidAmount: 1000 });
  });

  // guards: BR-CASH-024, BR-INV-018
  it('оплата наряду: рахунок наряду перераховується з наряду (дзеркало), а не окремим мінусом', async () => {
    // Рахунок розійшовся з нарядом (500 проти 1000) — після сторно він дорівнює наряду: 600.
    const h = makeHarness({ invoice: { status: 'PARTIALLY_PAID', paidAmount: 500 } });
    await h.reverse();
    expect(Number(h.workOrder?.paidAmount)).toBe(600);
    expect(h.invoice).toMatchObject({ status: 'PARTIALLY_PAID', paidAmount: 600 });
  });

  // Порядок блокувань «наряд → рахунок» — той самий, що в оплаті.
  // guards: BR-CASH-024, BR-PAY-005
  it('сторно оплати наряду пише рядок наряду раніше за рахунок', async () => {
    const h = makeHarness();
    await h.reverse();
    const woWrite = h.tables.workOrder.updateMany.mock.invocationCallOrder[0]!;
    const invWrite = h.tables.invoice.updateMany.mock.invocationCallOrder[0]!;
    expect(woWrite).toBeLessThan(invWrite);
  });

  // guards: BR-CASH-024
  it('оплата без рахунку — жодного рахунку не чіпає', async () => {
    const h = makeHarness({ payment: { invoiceId: null } });
    const other = {
      id: 'b9999999-0000-4000-8000-000000000009',
      orgId: ORG,
      status: 'PAID',
      amount: 400,
      paidAmount: 400,
      workOrderId: WO,
      counterpartyId: CLIENT,
      deletedAt: null,
    };
    h.tables.invoice.rows.push(other);
    await h.reverse();
    expect(other).toMatchObject({ status: 'PAID', paidAmount: 400 });
  });
});

describe('PaymentsService.reverse — «сплачено» і статус наряду', () => {
  // guards: BR-CASH-024
  it('наряд «Оплачено», оплата за нарядом на всю суму → «сплачено» 0, наряд «Виставлено» — внутрішнім записом, не через FSM', async () => {
    const h = makeHarness({
      payment: { invoiceId: null, amount: 1000, amountBase: 1000 },
      invoice: null,
      workOrder: { status: 'PAID', totalAmount: 1000, paidAmount: 1000 },
    });
    await h.reverse();
    expect(Number(h.workOrder?.paidAmount)).toBe(0);
    expect(h.workOrder?.status).toBe('INVOICED');
    expect(h.workOrders.transition).not.toHaveBeenCalled();
  });

  // guards: BR-CASH-024
  it('часткове сторно оплаченого наряду (400 з 1000) → 600 і «Виставлено» — повністю вже не сплачений', async () => {
    const h = makeHarness({ payment: { invoiceId: null }, invoice: null });
    await h.reverse();
    expect(Number(h.workOrder?.paidAmount)).toBe(600);
    expect(h.workOrder?.status).toBe('INVOICED');
  });

  // guards: BR-CASH-024
  it('наряд «Виставлено» з частковою оплатою → лише «сплачено» мінус сума, статус той самий', async () => {
    const h = makeHarness({
      payment: { invoiceId: null, amount: 250.25, amountBase: 250.25 },
      invoice: null,
      workOrder: { status: 'INVOICED', paidAmount: 600.5 },
    });
    await h.reverse();
    expect(Number(h.workOrder?.paidAmount)).toBeCloseTo(350.25, 2);
    expect(h.workOrder?.status).toBe('INVOICED');
  });

  // guards: BR-CASH-024
  it('«сплачено» наряду не йде нижче нуля', async () => {
    const h = makeHarness({
      payment: { invoiceId: null, amount: 400, amountBase: 400 },
      invoice: null,
      workOrder: { status: 'INVOICED', paidAmount: 150 },
    });
    await h.reverse();
    expect(Number(h.workOrder?.paidAmount)).toBe(0);
  });

  // Наряд піднімається лише оплатою, що мала workOrderId (так само, як при оплаті). Оплата
  // standalone-рахунку, прив'язаного до наряду, «сплачено» наряду не піднімала — і не знімає.
  // guards: BR-CASH-024
  it('оплата без workOrderId (лише рахунок наряду) → наряд не змінюється', async () => {
    const h = makeHarness({ payment: { workOrderId: null } });
    await h.reverse();
    expect(h.workOrder).toMatchObject({ status: 'PAID', paidAmount: 1000 });
  });

  // guards: BR-CASH-024
  it('наряд оплати в архіві → 400 «Наряд оплати в архіві»', async () => {
    const h = makeHarness({ workOrder: { status: 'ARCHIVED' } });
    const call = h.reverse();
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/в архіві/);
  });
});

describe('PaymentsService.reverse — фіскальний чек і валюта', () => {
  // Чека повернення в системі немає: пробитий чек сторно «тихо» не скасує.
  // guards: BR-CASH-024
  it('чек уже пробито (fiscalStatus = DONE) → 400 «…спершу оформіть повернення в ПРРО»', async () => {
    const h = makeHarness({ payment: { fiscalStatus: 'DONE', fiscalReceiptId: 'fr-1' } });
    const call = h.reverse();
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/ПРРО/);
  });

  // guards: BR-CASH-024
  it('чек, відхилений ПРРО (FAILED) → SKIPPED: повтор фіскалізації його вже не поставить', async () => {
    const h = makeHarness({ payment: { fiscalStatus: 'FAILED' } });
    await h.reverse();
    expect(h.payment.fiscalStatus).toBe('SKIPPED');
  });

  // Чек у черзі може бути вже в дорозі до ПРРО: пробитий після сторно, він лишився б за оплатою,
  // якої немає. Сторно чекає відповіді ПРРО; текст пояснює й закриту зміну.
  // guards: BR-PAY-029
  it('чек ще в черзі ПРРО (QUEUED) → 400 до будь-якого запису; оплата, чек і журнал без змін', async () => {
    const h = makeHarness({ payment: { fiscalStatus: 'QUEUED' } });
    const call = h.reverse();
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(/відкрийте зміну/);
    expect(h.payment).toMatchObject({ fiscalStatus: 'QUEUED', reversedAt: null });
    expect(h.settlementRows).toEqual([]);
    expect(h.tables.domainEvent.rows).toEqual([]);
    expect(h.loyalty.reverseEarn).not.toHaveBeenCalled();
  });

  // guards: BR-CASH-024
  it('фіскалізація не застосовна (null) → лишається null', async () => {
    const h = makeHarness({ payment: { fiscalStatus: null } });
    await h.reverse();
    expect(h.payment.fiscalStatus).toBeNull();
  });
});

describe('PaymentsService.reverse — бонуси', () => {
  // guards: BR-CASH-024
  it('нараховані за оплату бонуси списуються: reverseEarn(orgId, id оплати)', async () => {
    const h = makeHarness();
    await h.reverse();
    expect(h.loyalty.reverseEarn).toHaveBeenCalledTimes(1);
    expect(h.loyalty.reverseEarn.mock.calls[0][0]).toBe(ORG);
    expect(h.loyalty.reverseEarn.mock.calls[0][1]).toBe(PAY);
  });
});

describe('PaymentsService.reverse — стан змінився між читанням і записом (review 2026-10-14)', () => {
  // Обробник чека пише DONE без блокування. Пробитий між читанням і CAS чек інакше пройшов би
  // повз відмову «чек уже пробито», а SKIPPED затер би його DONE.
  // guards: BR-CASH-024
  it('прочитано FAILED, а чек уже пробито (DONE) → 400 «…ПРРО», оплату не сторновано, DONE лишився', async () => {
    const h = makeHarness({ payment: { fiscalStatus: 'FAILED' } });
    staleRead(h.tables.payment, { ...h.payment });
    h.payment.fiscalStatus = 'DONE';
    h.payment.fiscalReceiptId = 'fr-race';
    const call = h.reverse();
    await expect(call).rejects.toThrow(/ПРРО/);
    expect(h.payment).toMatchObject({ fiscalStatus: 'DONE', reversedAt: null });
    expect(h.settlementRows).toEqual([]);
  });

  // Стан чека — частина умови запису: прочитано FAILED, а «Повторити чек» уже поставив його в
  // чергу (QUEUED) — сторно відмовляє «оновіть сторінку», а не пише поверх.
  // guards: BR-CASH-024
  it('прочитано FAILED, а чек уже знову в черзі (QUEUED, без номера) → 400, оплату не сторновано', async () => {
    const h = makeHarness({ payment: { fiscalStatus: 'FAILED' } });
    staleRead(h.tables.payment, { ...h.payment });
    h.payment.fiscalStatus = 'QUEUED';
    await expect(h.reverse()).rejects.toThrow(/оновіть сторінку/);
    expect(h.payment).toMatchObject({ fiscalStatus: 'QUEUED', reversedAt: null });
  });

  // guards: BR-CASH-024
  it('рахунок: паралельна оплата змінила «сплачено» (статус той самий) → 400, рахунок не чіпано', async () => {
    const h = makeHarness({
      payment: { workOrderId: null, amount: 100, amountBase: 100 },
      invoice: { status: 'PARTIALLY_PAID', paidAmount: 300 },
    });
    staleRead(h.tables.invoice, { ...h.invoice });
    if (h.invoice) h.invoice.paidAmount = 500;
    await expect(h.reverse()).rejects.toThrow(BadRequestException);
    expect(h.invoice).toMatchObject({ status: 'PARTIALLY_PAID', paidAmount: 500 });
  });

  // guards: BR-CASH-024
  it('наряд «Оплачено»: між читанням і записом «сплачено» змінилось → 400, статус не чіпано', async () => {
    const h = makeHarness({ payment: { invoiceId: null }, invoice: null });
    staleRead(h.tables.workOrder, { ...h.workOrder });
    if (h.workOrder) h.workOrder.paidAmount = 900;
    await expect(h.reverse()).rejects.toThrow(BadRequestException);
    expect(h.workOrder).toMatchObject({ status: 'PAID', paidAmount: 900 });
  });

  // guards: BR-CASH-024
  it('наряд прочитано «Оплачено», а він уже в архіві → 400, архів не повернуто у «Виставлено»', async () => {
    const h = makeHarness({ payment: { invoiceId: null }, invoice: null });
    staleRead(h.tables.workOrder, { ...h.workOrder });
    if (h.workOrder) h.workOrder.status = 'ARCHIVED';
    await expect(h.reverse()).rejects.toThrow(BadRequestException);
    expect(h.workOrder).toMatchObject({ status: 'ARCHIVED', paidAmount: 1000 });
  });
});

describe('PaymentsService.reverse — інші оплати й далі покривають суму (BR-PAY-017 навпаки)', () => {
  // Сторно однієї з оплат, коли решта й далі покриває суму документа: статус «Оплачено»
  // лишається — так само, як create поставив би його при тих самих сумах.
  // guards: BR-CASH-024
  it('наряд «Оплачено» 1400 при сумі 1000, сторно 400 → 1000 і далі «Оплачено»', async () => {
    const h = makeHarness({
      payment: { invoiceId: null },
      invoice: null,
      workOrder: { status: 'PAID', totalAmount: 1000, paidAmount: 1400 },
    });
    const result = await h.reverse();
    expect(h.workOrder).toMatchObject({ status: 'PAID' });
    expect(Number(h.workOrder?.paidAmount)).toBe(1000);
    expect(result.reopenedWorkOrderId).toBeNull();
  });

  // guards: BR-CASH-024
  it('рахунок «Оплачено» 1400 при сумі 1000, сторно 400 → 1000 і далі «Оплачено»', async () => {
    const h = makeHarness({
      payment: { workOrderId: null },
      invoice: { status: 'PAID', amount: 1000, paidAmount: 1400 },
    });
    await h.reverse();
    expect(h.invoice).toMatchObject({ status: 'PAID' });
    expect(Number(h.invoice?.paidAmount)).toBe(1000);
  });
});

describe('PaymentsService.reverse — події outbox (BR-AUT-060)', () => {
  const events = (h: ReturnType<typeof makeHarness>) =>
    h.tables.domainEvent.rows.map(e => ({
      documentType: e.documentType,
      documentId: e.documentId,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      actorId: e.actorId,
    }));

  // guards: BR-AUT-060
  it('сторно → подія оплати STATUS_CHANGED «ACTIVE» → «REVERSED» з автором сторно; наряд PAID → INVOICED — своя подія', async () => {
    const h = makeHarness({
      payment: { invoiceId: null, amount: 1000, amountBase: 1000 },
      invoice: null,
      workOrder: { status: 'PAID', totalAmount: 1000, paidAmount: 1000 },
    });
    await h.reverse();
    expect(events(h)).toEqual([
      {
        documentType: 'PAYMENT',
        documentId: PAY,
        fromStatus: 'ACTIVE',
        toStatus: 'REVERSED',
        actorId: USER,
      },
      {
        documentType: 'WORK_ORDER',
        documentId: WO,
        fromStatus: 'PAID',
        toStatus: 'INVOICED',
        actorId: USER,
      },
    ]);
    expect(h.tables.domainEvent.rows.every(e => e.kind === 'STATUS_CHANGED')).toBe(true);
  });

  // guards: BR-AUT-060
  it('рахунок без наряду: PAID → SENT — подія рахунку; лише «сплачено» без зміни статусу — без події', async () => {
    const h = makeHarness({
      payment: { amount: 1000, amountBase: 1000, workOrderId: null },
      invoice: { status: 'PAID', paidAmount: 1000 },
    });
    await h.reverse();
    expect(events(h)).toContainEqual(
      expect.objectContaining({ documentType: 'INVOICE', fromStatus: 'PAID', toStatus: 'SENT' }),
    );

    const partial = makeHarness({
      payment: { amount: 0.01, amountBase: 0.01, workOrderId: null },
      invoice: { status: 'PARTIALLY_PAID', paidAmount: 700 },
    });
    await partial.reverse();
    expect(events(partial).filter(e => e.documentType === 'INVOICE')).toEqual([]);
  });

  // guards: BR-AUT-060
  it('повторне сторно → 400 і другої події немає', async () => {
    const h = makeHarness();
    await h.reverse();
    const before = h.tables.domainEvent.rows.length;
    await expect(h.reverse()).rejects.toThrow(BadRequestException);
    expect(h.tables.domainEvent.rows).toHaveLength(before);
  });
});

describe('PaymentsService.afterReversal — аудит після коміту', () => {
  // guards: BR-CASH-024
  it('наряд повернувся у «Виставлено» → аудит наряду PAID → INVOICED поруч з аудитом оплати', async () => {
    const h = makeHarness({ payment: { invoiceId: null }, invoice: null });
    h.loyalty.reverseEarn.mockResolvedValue({ earned: 0, deducted: 0 });
    const result = await h.reverse();
    h.service.afterReversal(ORG, result, USER);
    expect(h.audit.record).toHaveBeenCalledWith(
      ORG,
      'WorkOrder',
      WO,
      'UPDATE',
      USER,
      { status: 'PAID' },
      { status: 'INVOICED' },
    );
    expect(h.audit.record).toHaveBeenCalledWith(
      ORG,
      'Payment',
      PAY,
      'UPDATE',
      USER,
      { reversedAt: null },
      expect.objectContaining({ reversalCashOperationId: STORNO_OP }),
    );
  });

  // guards: BR-CASH-024
  it('статус наряду не змінювався → аудиту наряду немає', async () => {
    const h = makeHarness({ workOrder: { status: 'INVOICED', paidAmount: 400 } });
    h.loyalty.reverseEarn.mockResolvedValue({ earned: 0, deducted: 0 });
    const result = await h.reverse();
    h.service.afterReversal(ORG, result, USER);
    expect(h.audit.record.mock.calls.map(c => c[1])).toEqual(['Payment']);
  });
});
