/**
 * Сторно оплати клієнта — валютна оплата, курсова різниця й прострочений рахунок (рішення власника
 * 2026-10-30, TECH-DEBT (б) №42, №44): `PaymentsService.reverse` сторнує валютну оплату за курсом
 * оплати й відкочує курсову різницю повної оплати, коли документ перестає бути сплаченим повністю
 * (BR-PAY-028); статус рахунку без наряду — за `invoiceStatusForPaid` (BR-INV-025).
 *
 * Harness — `payments.reverse.spec-fixture.ts` (той самий, що в `payments.reverse.spec.ts`).
 */
import { describe, it, expect } from 'vitest';
import { CLIENT, INV, ORG, WO, makeHarness } from './payments.reverse.spec-fixture';
import type { MemRow } from '../cash/cash.spec-fixture';

// Валютна оплата сторнується за курсом оплати; курсова різниця, визнана при повній оплаті,
// відкочується, коли документ перестає бути сплаченим повністю (рішення власника 2026-10-30).
describe('PaymentsService.reverse — валютна оплата і курсова різниця (BR-PAY-028)', () => {
  const USD = 'usd-id';
  const fxRows = (h: ReturnType<typeof makeHarness>) =>
    h.settlementRows.filter(r => r.type === 'FX_GAIN' || r.type === 'FX_LOSS');
  /** Курсова різниця повної оплати наряду (за нарядом, як `postWorkOrderFxInTx`). */
  const woFx = (type: string, amountBase: number, id = 'st-fx'): MemRow => ({
    id,
    orgId: ORG,
    settlementAccountId: 'acc-1',
    type,
    amount: amountBase,
    amountBase,
    rateUsed: 1,
    currencyId: null,
    documentType: 'WorkOrder',
    documentId: WO,
  });

  // guards: BR-PAY-028
  it('USD-оплата наряду → PAYMENT_CANCEL за курсом ОПЛАТИ (сума й база оригіналу), без 400', async () => {
    const h = makeHarness({
      payment: { currencyId: USD, amount: 100, amountBase: 4147, rateUsed: 41.47 },
      workOrder: { currencyId: USD, totalAmount: 100, paidAmount: 100 },
      invoice: null,
    });

    await h.reverse();

    expect(h.settlementRows.find(r => r.type === 'PAYMENT_CANCEL')).toMatchObject({
      amount: 100,
      currencyId: USD,
      conversion: { rateUsed: 41.47, amountBase: 4147 },
    });
    expect(h.payment.reversedAt).toBeInstanceOf(Date);
  });

  // guards: BR-PAY-028
  it('наряд перестав бути сплаченим → зворотна курсова різниця на чисту суму за нарядом, у tx каси', async () => {
    const h = makeHarness({
      payment: { currencyId: USD, amount: 100, amountBase: 4147, rateUsed: 41.47 },
      workOrder: { currencyId: USD, totalAmount: 100, paidAmount: 100 },
      invoice: null,
      journal: [woFx('FX_LOSS', 53)],
    });

    await h.reverse();

    expect(fxRows(h)).toEqual([
      expect.objectContaining({
        type: 'FX_GAIN',
        amount: 53,
        counterpartyId: CLIENT,
        documentType: 'WorkOrder',
        documentId: WO,
        __tx: h.tx,
      }),
    ]);
    // Курсова різниця — базова дельта, без валюти (інакше createTransaction перерахував би її).
    expect(fxRows(h)[0]!.currencyId).toBeUndefined();
  });

  // guards: BR-PAY-028
  it('чиста курсова різниця — сума всіх FX документа: FX_GAIN 30 і FX_LOSS 80 → FX_GAIN 50', async () => {
    const h = makeHarness({
      payment: { currencyId: USD, amount: 100, amountBase: 4147, rateUsed: 41.47 },
      workOrder: { currencyId: USD, totalAmount: 100, paidAmount: 100 },
      invoice: null,
      journal: [woFx('FX_GAIN', 30, 'st-fx-1'), woFx('FX_LOSS', 80, 'st-fx-2')],
    });

    await h.reverse();

    expect(fxRows(h)).toEqual([expect.objectContaining({ type: 'FX_GAIN', amount: 50 })]);
  });

  // guards: BR-PAY-028
  it('чиста FX уже 0 (визнано й відкочено раніше) → нової курсової проводки немає', async () => {
    const h = makeHarness({
      payment: { currencyId: USD, amount: 100, amountBase: 4147, rateUsed: 41.47 },
      workOrder: { currencyId: USD, totalAmount: 100, paidAmount: 100 },
      invoice: null,
      journal: [woFx('FX_LOSS', 53, 'st-fx-1'), woFx('FX_GAIN', 53, 'st-fx-2')],
    });

    await h.reverse();

    expect(fxRows(h)).toEqual([]);
  });

  // Переплачений наряд (1400 при сумі 1000): після сторно 400 він і далі сплачений повністю —
  // курсова різниця лишається.
  // guards: BR-PAY-028
  it('наряд і після сторно сплачений повністю → курсову різницю не чіпаємо', async () => {
    const h = makeHarness({
      payment: { currencyId: USD, amount: 400, amountBase: 16588, rateUsed: 41.47 },
      workOrder: { currencyId: USD, totalAmount: 1000, paidAmount: 1400 },
      invoice: null,
      journal: [woFx('FX_LOSS', 53)],
    });

    await h.reverse();

    expect(fxRows(h)).toEqual([]);
  });

  // guards: BR-PAY-028
  it('рахунок без наряду перестав бути сплаченим → зворотна курсова різниця за рахунком', async () => {
    const h = makeHarness({
      payment: {
        currencyId: USD,
        workOrderId: null,
        amount: 100,
        amountBase: 4147,
        rateUsed: 41.47,
      },
      workOrder: null,
      invoice: { workOrderId: null, currencyId: USD, amount: 100, paidAmount: 100, status: 'PAID' },
      journal: [
        {
          id: 'st-fx',
          orgId: ORG,
          settlementAccountId: 'acc-1',
          type: 'FX_GAIN',
          amount: 20,
          amountBase: 20,
          rateUsed: 1,
          currencyId: null,
          documentType: 'Invoice',
          documentId: INV,
        },
      ],
    });

    await h.reverse();

    expect(fxRows(h)).toEqual([
      expect.objectContaining({
        type: 'FX_LOSS',
        amount: 20,
        counterpartyId: CLIENT,
        documentType: 'Invoice',
        documentId: INV,
      }),
    ]);
  });
});

// Рішення власника 2026-10-30 (TECH-DEBT (б) №44): сторно оплати простроченого рахунку повертає
// його у «Прострочено» одразу, а не у «Виставлено» до нічної позначки.
describe('PaymentsService.reverse — прострочений рахунок без наряду (BR-INV-025)', () => {
  const PAST = new Date('2020-01-10T00:00:00.000Z');

  // guards: BR-INV-025
  it('сторно повної оплати рахунку з минулим терміном → «Прострочено», подія PAID → OVERDUE', async () => {
    const h = makeHarness({
      payment: { workOrderId: null, amount: 1000, amountBase: 1000 },
      workOrder: null,
      invoice: { workOrderId: null, status: 'PAID', amount: 1000, paidAmount: 1000, dueDate: PAST },
    });

    await h.reverse();

    expect(h.invoice).toMatchObject({ paidAmount: 0, status: 'OVERDUE' });
    expect(h.tables.domainEvent.rows).toContainEqual(
      expect.objectContaining({ documentType: 'INVOICE', fromStatus: 'PAID', toStatus: 'OVERDUE' }),
    );
  });

  // guards: BR-INV-025
  it('часткове сторно простроченого рахунку → «Прострочено»; термін не минув → «Частково оплачено»', async () => {
    const overdue = makeHarness({
      payment: { workOrderId: null },
      workOrder: null,
      invoice: { workOrderId: null, status: 'PAID', amount: 1000, paidAmount: 1000, dueDate: PAST },
    });
    await overdue.reverse();
    expect(overdue.invoice).toMatchObject({ paidAmount: 600, status: 'OVERDUE' });

    const onTime = makeHarness({
      payment: { workOrderId: null },
      workOrder: null,
      invoice: {
        workOrderId: null,
        status: 'PAID',
        amount: 1000,
        paidAmount: 1000,
        dueDate: new Date('2999-01-10T00:00:00.000Z'),
      },
    });
    await onTime.reverse();
    expect(onTime.invoice).toMatchObject({ paidAmount: 600, status: 'PARTIALLY_PAID' });
  });
});
