/**
 * SupplierPaymentsService.confirm(orgId, id, userId, { rateDate }) — дата курсу проведення.
 *
 * НАВІЩО. Вихідний банківський платіж, рознесений як НОВА оплата постачальнику (BR-BANK-028),
 * проводиться за курсом на дату операції рядка виписки, а не на день рознесення: рядок від 28.09,
 * рознесений 03.10, мусить зменшити борг постачальнику за курсом 28.09. Для цього `confirm`
 * отримує необов'язковий `opts.rateDate`. Без нього — стара поведінка: курс на момент проведення.
 *
 * Написано ДО реалізації (2026-10-09): четвертого параметра в сигнатурі ще немає, тому виклик
 * іде через приведення типу (`confirmAt`). Кейси з `rateDate` червоні, доки параметр не з'явиться.
 *
 * Mutation-verify: (1) ігнорувати `opts.rateDate` (лишити `const confirmDate = new Date()`) →
 * обидва кейси «з rateDate»; (2) передати rateDate лише в resolveBaseConversion, але не в `date`
 * проведення → «проведення взаєморозрахунків датується rateDate»; (3) завжди вимагати rateDate →
 * кейс «без opts — поточна дата».
 *
 * Сетап — `makeSpHarness()` з `./supplier-payments.spec-fixture`.
 */
import { SupplierPaymentStatus, PaymentSourceType } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeSpHarness,
  type SpHarness,
  ORG,
  SP_ID,
  SUPPLIER_ID,
  BANK_ID,
  USER_ID,
  confirmedRow,
} from './supplier-payments.spec-fixture';

const USD = '55555555-5555-4555-8555-555555555555';
/** Дата операції рядка виписки: календарна дата, північ UTC. */
const RATE_DATE = new Date('2026-09-28T00:00:00.000Z');
/** «Зараз» — день рознесення, на п'ять днів пізніше. */
const NOW = new Date('2026-10-03T09:15:00.000Z');

type ConfirmWithOpts = (
  orgId: string,
  id: string,
  userId: string,
  opts?: { rateDate?: Date },
) => Promise<unknown>;

describe('SupplierPaymentsService.confirm — дата курсу (opts.rateDate)', () => {
  let h: SpHarness;

  /** Виклик із четвертим аргументом, якого контракт сервісу ще не оголосив. */
  const confirmAt = (opts?: { rateDate?: Date }) =>
    (h.service.confirm as unknown as ConfirmWithOpts).call(h.service, ORG, SP_ID, USER_ID, opts);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    h = await makeSpHarness();
    h.prisma.supplierPayment.findFirst
      // Знімок перед транзакцією: валютна банківська оплата-чернетка без замовлення.
      .mockResolvedValueOnce({
        status: SupplierPaymentStatus.DRAFT,
        supplierId: SUPPLIER_ID,
        amount: 200,
        sourceType: PaymentSourceType.BANK_ACCOUNT,
        bankAccountId: BANK_ID,
        cashRegisterId: null,
        currencyId: USD,
        purchaseOrderId: null,
      })
      .mockResolvedValueOnce(confirmedRow); // findOne наприкінці
    h.exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 41.5, amountBase: 8300 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // guards: BR-BANK-028
  it('з rateDate: курс береться на rateDate, а не на день проведення', async () => {
    await confirmAt({ rateDate: RATE_DATE });

    expect(h.exchangeRates.resolveBaseConversion).toHaveBeenCalledTimes(1);
    const [orgArg, currencyArg, dateArg, amountArg] =
      h.exchangeRates.resolveBaseConversion.mock.calls[0]!;
    expect(orgArg).toBe(ORG);
    expect(currencyArg).toBe(USD);
    expect((dateArg as Date).toISOString()).toBe(RATE_DATE.toISOString());
    expect(amountArg).toBe(200);
    // База й курс, пораховані на rateDate, фіксуються в оплаті.
    expect(h.prisma.supplierPayment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: SupplierPaymentStatus.CONFIRMED,
          totalAmountBase: 8300,
          rateUsed: 41.5,
        }),
      }),
    );
  });

  // SettlementsService.createTransaction сам рахує базову суму за `date` — якщо туди піде «зараз»,
  // борг постачальнику зменшиться за ІНШИМ курсом, ніж записано в оплаті.
  // guards: BR-BANK-028
  it('з rateDate: проведення взаєморозрахунків отримує date = rateDate', async () => {
    await confirmAt({ rateDate: RATE_DATE });

    expect(h.settlements.createTransaction).toHaveBeenCalledTimes(1);
    const posting = h.settlements.createTransaction.mock.calls[0]![1];
    expect(posting).toMatchObject({
      type: 'SUPPLIER_PAYMENT',
      counterpartyId: SUPPLIER_ID,
      amount: 200,
      currencyId: USD,
      documentType: 'SupplierPayment',
      documentId: SP_ID,
    });
    expect((posting.date as Date).toISOString()).toBe(RATE_DATE.toISOString());
  });

  // guards: BR-BANK-028
  it.each([
    ['без opts', undefined],
    ['з порожнім opts', {}],
  ])('%s — стара поведінка: курс і дата проведення на поточний момент', async (_name, opts) => {
    await confirmAt(opts);

    const dateArg = h.exchangeRates.resolveBaseConversion.mock.calls[0]![2] as Date;
    expect(dateArg.toISOString()).toBe(NOW.toISOString());
    const posting = h.settlements.createTransaction.mock.calls[0]![1];
    expect((posting.date as Date).toISOString()).toBe(NOW.toISOString());
  });
});
