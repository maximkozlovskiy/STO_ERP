/**
 * Сторно безготівкової оплати клієнта (BR-PAY-024) — `PaymentsService.reverseNonCash`:
 *
 *   • сторнується оплата без касового рядка: на банківський рахунок, з рознесення виписки, стара
 *     без призначення; наслідки — ті самі, що в касовому сторно (той самий `reverse`): проводка
 *     `PAYMENT_CANCEL` з курсом оригіналу, «сплачено» й статуси наряду та рахунку;
 *   • документ проводки сторно — сама оплата (`Payment` / id оплати), не касовий рядок;
 *   • в оплату пишуться причина й автор (для касового сторно теж);
 *   • оплата з рознесення виписки: у тій самій транзакції рядок виписки CAS MATCHED → UNMATCHED,
 *     `paymentId = null`, `unmatchReason/At/By` (BR-BANK-040);
 *   • відмови — до першого запису: касова оплата, онлайн-оплата QR, уже сторнована; програний CAS
 *     рядка виписки відкочує все.
 *
 * Таблиці — у пам'яті (`memoryTable`): `where` виконується по-справжньому. `$transaction` знімає
 * знімок таблиць і повертає його, якщо колбек кинув, — як відкат транзакції БД.
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { translateError } from '@sto/shared';
import { PaymentsService } from './payments.service';
import { exchangeRatesMock } from './payments.spec-fixture';
import { memoryTable, type MemRow } from '../cash/cash.spec-fixture';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SettlementsService } from '../settlements/settlements.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { WorkOrdersService } from '../work-orders/work-orders.service';
import type { LoyaltyService } from '../loyalty/loyalty.service';
import type { AuditService } from '../audit/audit.service';
import type { CashService } from '../cash/cash.service';
import type { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const CLIENT = 'c0000001-0000-4000-8000-000000000001';
const USER = '44444444-4444-4444-8444-444444444444';
const PAY = 'a1000001-0000-4000-8000-000000000001';
const INV = 'b1000001-0000-4000-8000-000000000001';
const WO = 'd1000001-0000-4000-8000-000000000001';
const BANK_ACC = 'ba000001-0000-4000-8000-000000000001';
const BANK_TX = 'bt000001-0000-4000-8000-000000000001';
const BASE = 'uah-id';
const REASON = 'помилкове рознесення';

const uk = (key: string) => translateError(key, 'uk');

interface Seed {
  payment?: MemRow;
  invoice?: MemRow | null;
  workOrder?: MemRow | null;
  /** Рядок виписки, з рознесення якого створено оплату; null — оплата не з виписки. */
  bankTx?: MemRow | null;
  /** Рядки каси (для старої готівкової оплати без `sourceType`). */
  cashOps?: MemRow[];
}

function makeHarness(seed: Seed = {}) {
  const payment: MemRow = {
    id: PAY,
    orgId: ORG,
    counterpartyId: CLIENT,
    workOrderId: WO,
    invoiceId: INV,
    amount: 1000,
    currencyId: BASE,
    amountBase: 1000,
    rateUsed: 1,
    method: 'bank',
    notes: null,
    sourceType: 'BANK_ACCOUNT',
    bankAccountId: BANK_ACC,
    cashRegisterId: null,
    onlinePaymentIntentId: null,
    fiscalStatus: null,
    fiscalReceiptId: null,
    fiscalError: null,
    reversedAt: null,
    reversalCashOperationId: null,
    reversalReason: null,
    reversedBy: null,
    createdAt: new Date('2026-10-20T09:00:00.000Z'),
    ...seed.payment,
  };
  const invoice: MemRow | null =
    seed.invoice === null
      ? null
      : {
          id: INV,
          orgId: ORG,
          counterpartyId: CLIENT,
          workOrderId: WO,
          status: 'PAID',
          amount: 1000,
          paidAmount: 1000,
          currencyId: null,
          deletedAt: null,
          ...seed.invoice,
        };
  const workOrder: MemRow | null =
    seed.workOrder === null
      ? null
      : {
          id: WO,
          orgId: ORG,
          counterpartyId: CLIENT,
          status: 'PAID',
          totalAmount: 1000,
          paidAmount: 1000,
          currencyId: null,
          deletedAt: null,
          ...seed.workOrder,
        };
  const bankTx: MemRow | null =
    seed.bankTx === undefined || seed.bankTx === null
      ? null
      : {
          id: BANK_TX,
          orgId: ORG,
          bankAccountId: BANK_ACC,
          direction: 'IN',
          status: 'MATCHED',
          matchedType: 'SERVICE',
          counterpartyId: CLIENT,
          paymentId: PAY,
          matchedAt: new Date('2026-10-20T09:00:00.000Z'),
          matchedBy: USER,
          unmatchReason: null,
          unmatchedAt: null,
          unmatchedBy: null,
          deletedAt: null,
          ...seed.bankTx,
        };

  const tables = {
    payment: memoryTable([payment]),
    invoice: memoryTable(invoice ? [invoice] : []),
    workOrder: memoryTable(workOrder ? [workOrder] : []),
    bankTransaction: memoryTable(bankTx ? [bankTx] : []),
    cashOperation: memoryTable(seed.cashOps ?? []),
    settlementTransaction: memoryTable([
      {
        id: 'st-orig',
        orgId: ORG,
        settlementAccountId: 'acc-1',
        type: 'PAYMENT',
        amount: payment.amount,
        amountBase: payment.amountBase,
        rateUsed: payment.rateUsed,
        currencyId: payment.currencyId,
        documentType: 'Payment',
        documentId: PAY,
        createdAt: new Date('2026-10-20T09:00:00.000Z'),
      },
    ]),
    organisationSettings: memoryTable([{ id: 'set-1', orgId: ORG, baseCurrencyId: BASE }]),
    currency: memoryTable([{ id: BASE, orgId: ORG, code: 'UAH', isBase: true, deletedAt: null }]),
  };

  const settlementRows: MemRow[] = [];
  const settlements = {
    createTransaction: vi.fn((orgId: string, dto: MemRow, client?: unknown) => {
      settlementRows.push({ orgId, ...dto, __tx: client });
      return Promise.resolve();
    }),
  };

  // Відкат транзакції: знімок кожного рядка (за ідентичністю об'єкта) і переліку проводок.
  const tx = { ...tables };
  const transaction = vi.fn(
    async (fn: (client: typeof tx) => Promise<unknown>, _opts?: unknown) => {
      const snapshot = Object.values(tables).map(t => ({
        rows: [...t.rows],
        copies: t.rows.map(r => ({ ...r })),
      }));
      const postings = settlementRows.length;
      try {
        return await fn(tx);
      } catch (e) {
        Object.values(tables).forEach((t, i) => {
          const { rows, copies } = snapshot[i];
          rows.forEach((row, j) => {
            for (const key of Object.keys(row)) delete row[key];
            Object.assign(row, copies[j]);
          });
          t.rows.splice(0, t.rows.length, ...rows);
        });
        settlementRows.length = postings;
        throw e;
      }
    },
  );
  const root = { ...tables, $transaction: transaction };

  const loyalty = {
    queueEarn: vi.fn().mockResolvedValue(undefined),
    reverseEarn: vi.fn().mockResolvedValue({ earned: 0, deducted: 0 }),
  };
  const exchangeRates = exchangeRatesMock();
  exchangeRates.getBaseCurrency.mockResolvedValue({ id: BASE, code: 'UAH' });
  exchangeRates.requireBaseCurrencyId.mockResolvedValue(BASE);
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const workOrders = { transition: vi.fn().mockResolvedValue(undefined) };

  const service = new PaymentsService(
    root as unknown as PrismaService,
    settlements as unknown as SettlementsService,
    { send: vi.fn().mockResolvedValue(undefined) } as unknown as NotificationsService,
    workOrders as unknown as WorkOrdersService,
    loyalty as unknown as LoyaltyService,
    audit as unknown as AuditService,
    { createOperation: vi.fn() } as unknown as CashService,
    exchangeRates as unknown as ExchangeRatesService,
    { add: vi.fn() } as unknown as Queue,
  );

  const reverseNonCash = (reason = REASON, orgId = ORG, paymentId = PAY) =>
    service.reverseNonCash(orgId, paymentId, { reason }, USER);

  return {
    service,
    tables,
    tx,
    transaction,
    settlementRows,
    payment,
    invoice,
    workOrder,
    bankTx,
    audit,
    workOrders,
    reverseNonCash,
  };
}

/** Нічого не записано: оплата не сторнована, проводок немає, наряд, рахунок і виписка ті самі. */
function expectNothingWritten(h: ReturnType<typeof makeHarness>) {
  expect(h.payment.reversedAt).toBeNull();
  expect(h.payment.reversalReason).toBeNull();
  expect(h.settlementRows).toEqual([]);
  if (h.workOrder) expect(h.workOrder).toMatchObject({ status: 'PAID', paidAmount: 1000 });
  if (h.invoice) expect(h.invoice).toMatchObject({ status: 'PAID', paidAmount: 1000 });
  if (h.bankTx) expect(h.bankTx).toMatchObject({ status: 'MATCHED', paymentId: PAY });
}

describe('PaymentsService.reverseNonCash — оплата на банківський рахунок', () => {
  // guards: BR-PAY-024
  it('сторно: оплата позначена, наряд «Оплачено» → «Виставлено», сплачено 0, рахунок наряду — дзеркало', async () => {
    const h = makeHarness();
    const dto = await h.reverseNonCash();
    expect(h.payment.reversedAt).toBeInstanceOf(Date);
    expect(h.workOrder).toMatchObject({ status: 'INVOICED' });
    expect(Number(h.workOrder?.paidAmount)).toBe(0);
    expect(Number(h.invoice?.paidAmount)).toBe(0);
    expect(h.workOrders.transition).not.toHaveBeenCalled();
    expect(dto.reversedAt).toEqual(expect.any(String));
  });

  // guards: BR-PAY-024
  it('документ проводки сторно — сама оплата (Payment / id оплати), курс і сума оригіналу, у транзакції', async () => {
    const h = makeHarness();
    await h.reverseNonCash();
    expect(h.settlementRows).toHaveLength(1);
    const posting = h.settlementRows[0];
    expect(posting).toMatchObject({
      orgId: ORG,
      counterpartyId: CLIENT,
      type: 'PAYMENT_CANCEL',
      documentType: 'Payment',
      documentId: PAY,
      notes: REASON,
      createdBy: USER,
    });
    expect(Number(posting.amount)).toBe(1000);
    const conversion = posting.conversion as { rateUsed: unknown; amountBase: unknown };
    expect(Number(conversion.rateUsed)).toBe(1);
    expect(Number(conversion.amountBase)).toBe(1000);
    expect(posting.__tx).toBe(h.tx);
  });

  // guards: BR-PAY-024
  it('причина (обрізана) й автор пишуться в оплату; касового рядка сторно немає', async () => {
    const h = makeHarness();
    await h.reverseNonCash(`  ${REASON}  `);
    expect(h.payment).toMatchObject({
      reversalReason: REASON,
      reversedBy: USER,
      reversalCashOperationId: null,
    });
  });

  // guards: BR-PAY-024
  it('оплата рахунку без наряду: «Оплачено» 1000, сторно 1000 → 0, «Виставлено»', async () => {
    const h = makeHarness({
      payment: { workOrderId: null },
      invoice: { workOrderId: null },
      workOrder: null,
    });
    await h.reverseNonCash();
    expect(h.invoice).toMatchObject({ status: 'SENT' });
    expect(Number(h.invoice?.paidAmount)).toBe(0);
  });

  // guards: BR-PAY-024
  it('транзакція власна, рівень ReadCommitted', async () => {
    const h = makeHarness();
    await h.reverseNonCash();
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: 'ReadCommitted' });
  });

  // guards: BR-PAY-024
  it('аудит після коміту: оплата з причиною й наряд PAID → INVOICED', async () => {
    const h = makeHarness();
    await h.reverseNonCash();
    expect(h.audit.record).toHaveBeenCalledWith(
      ORG,
      'Payment',
      PAY,
      'UPDATE',
      USER,
      { reversedAt: null },
      expect.objectContaining({ reversalReason: REASON, reversalCashOperationId: null }),
    );
    expect(h.audit.record).toHaveBeenCalledWith(
      ORG,
      'WorkOrder',
      WO,
      'UPDATE',
      USER,
      { status: 'PAID' },
      { status: 'INVOICED' },
    );
  });
});

describe('PaymentsService.reverseNonCash — оплата з рознесення виписки (BR-BANK-040)', () => {
  // guards: BR-PAY-024, BR-BANK-040
  it('рядок виписки → «Нерознесений» без оплати, виду й контрагента; причина, час і автор збережені', async () => {
    const h = makeHarness({ bankTx: {} });
    await h.reverseNonCash();
    expect(h.bankTx).toMatchObject({
      status: 'UNMATCHED',
      paymentId: null,
      matchedType: null,
      counterpartyId: null,
      matchedAt: null,
      matchedBy: null,
      unmatchReason: REASON,
      unmatchedBy: USER,
    });
    expect(h.bankTx?.unmatchedAt).toBeInstanceOf(Date);
    expect(h.payment.reversedAt).toBeInstanceOf(Date);
    expect(h.settlementRows.map(r => r.type)).toEqual(['PAYMENT_CANCEL']);
  });

  // guards: BR-PAY-024, BR-BANK-040
  it('аудит рядка виписки: MATCHED з оплатою → UNMATCHED з причиною', async () => {
    const h = makeHarness({ bankTx: {} });
    await h.reverseNonCash();
    expect(h.audit.record).toHaveBeenCalledWith(
      ORG,
      'BankTransaction',
      BANK_TX,
      'UPDATE',
      USER,
      expect.objectContaining({ status: 'MATCHED', paymentId: PAY }),
      expect.objectContaining({ status: 'UNMATCHED', paymentId: null, unmatchReason: REASON }),
    );
  });

  // REFUND (рознесення виписки як повернення) має той самий знак, що й PAYMENT — сторно теж +1.
  // guards: BR-PAY-024
  it('оплата-повернення з виписки (проводка REFUND) → PAYMENT_CANCEL', async () => {
    const h = makeHarness({
      payment: { workOrderId: null, invoiceId: null },
      invoice: null,
      workOrder: null,
      bankTx: { matchedType: 'REFUND' },
    });
    h.tables.settlementTransaction.rows[0].type = 'REFUND';
    await h.reverseNonCash();
    expect(h.settlementRows.map(r => r.type)).toEqual(['PAYMENT_CANCEL']);
    expect(h.bankTx).toMatchObject({ status: 'UNMATCHED', paymentId: null });
  });

  // Рядок прочитано рознесеним на цю оплату, а до запису він уже інший (CAS програно): сторно
  // відкочується разом із усім, що встиг записати `reverse`.
  // guards: BR-PAY-024, BR-BANK-040
  it('CAS рядка виписки програно → 409, сторно відкочено: оплата, наряд, рахунок і проводки як були', async () => {
    const h = makeHarness({ bankTx: {} });
    const snapshot = { ...h.bankTx };
    h.tables.bankTransaction.findFirst.mockImplementationOnce(() =>
      Promise.resolve({ ...snapshot }),
    );
    if (h.bankTx) {
      h.bankTx.status = 'UNMATCHED';
      h.bankTx.paymentId = null;
    }
    const call = h.reverseNonCash();
    await expect(call).rejects.toThrow(ConflictException);
    expect(h.payment.reversedAt).toBeNull();
    expect(h.settlementRows).toEqual([]);
    expect(h.workOrder).toMatchObject({ status: 'PAID', paidAmount: 1000 });
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  // Відмова самого `reverse` (чек пробито) — рядок виписки лишається рознесеним.
  // guards: BR-PAY-024
  it('чек уже пробито → 400, рядок виписки лишається MATCHED з оплатою', async () => {
    const h = makeHarness({
      payment: { fiscalStatus: 'DONE', fiscalReceiptId: 'fr-1' },
      bankTx: {},
    });
    await expect(h.reverseNonCash()).rejects.toThrow(/ПРРО/);
    expectNothingWritten(h);
  });
});

describe('PaymentsService.reverseNonCash — стара оплата без призначення', () => {
  // guards: BR-PAY-024
  it('без sourceType і без рядка каси → сторнується так само', async () => {
    const h = makeHarness({
      payment: { sourceType: null, bankAccountId: null, method: 'TRANSFER' },
    });
    await h.reverseNonCash();
    expect(h.payment.reversedAt).toBeInstanceOf(Date);
    expect(h.settlementRows[0]).toMatchObject({ documentType: 'Payment', documentId: PAY });
  });
});

describe('PaymentsService.reverseNonCash — відмови до першого запису', () => {
  // guards: BR-PAY-024
  it('оплата через касу (sourceType = CASH_REGISTER) → 400 «…сторнуйте касову операцію»', async () => {
    const h = makeHarness({
      payment: { sourceType: 'CASH_REGISTER', cashRegisterId: 'cr-1', bankAccountId: null },
    });
    const call = h.reverseNonCash();
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(uk('err.payment.reversalCashRow'));
    expectNothingWritten(h);
  });

  // Стара готівкова оплата могла не мати `sourceType`, але має рядок каси — теж лише в касі.
  // guards: BR-PAY-024
  it('стара оплата без sourceType, але з рядком каси → 400 «…сторнуйте касову операцію»', async () => {
    const h = makeHarness({
      payment: { sourceType: null, bankAccountId: null, method: 'cash' },
      cashOps: [{ id: 'co-1', orgId: ORG, documentType: 'Payment', documentId: PAY }],
    });
    await expect(h.reverseNonCash()).rejects.toThrow(uk('err.payment.reversalCashRow'));
    expectNothingWritten(h);
  });

  // guards: BR-PAY-024
  it('рядок каси іншої організації з тим самим documentId не робить оплату касовою', async () => {
    const h = makeHarness({
      payment: { sourceType: null, bankAccountId: null },
      cashOps: [{ id: 'co-x', orgId: OTHER_ORG, documentType: 'Payment', documentId: PAY }],
    });
    await h.reverseNonCash();
    expect(h.payment.reversedAt).toBeInstanceOf(Date);
  });

  // guards: BR-PAY-024
  it('онлайн-оплата QR → 400 «…повернення в кабінеті платіжного сервісу»', async () => {
    const h = makeHarness({
      payment: { onlinePaymentIntentId: 'f1000001-0000-4000-8000-000000000001' },
    });
    const call = h.reverseNonCash();
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(uk('err.payment.reversalOnlineQr'));
    expectNothingWritten(h);
  });

  // guards: BR-PAY-024
  it('уже сторнована → 400 «Оплату вже сторновано», другої проводки немає', async () => {
    const h = makeHarness();
    await h.reverseNonCash();
    const call = h.reverseNonCash();
    await expect(call).rejects.toThrow(BadRequestException);
    await expect(call).rejects.toThrow(uk('err.payment.alreadyReversed'));
    expect(h.settlementRows.filter(r => r.type === 'PAYMENT_CANCEL')).toHaveLength(1);
  });

  // Два сторно разом: обидва прочитали «не сторновано»; зупиняє CAS `reversedAt: null` у
  // `reverse`, і другий не звільняє рядок виписки повторно.
  // guards: BR-PAY-024
  it('гонка: прочитано «не сторновано», а оплату вже сторновано → 400, виписка й проводки не чіпаються', async () => {
    const h = makeHarness({ bankTx: {} });
    const stale = { ...h.payment };
    h.tables.payment.findFirst.mockImplementation(() => Promise.resolve({ ...stale }));
    h.payment.reversedAt = new Date('2026-10-21T10:00:00.000Z');
    await expect(h.reverseNonCash()).rejects.toThrow(BadRequestException);
    expect(h.settlementRows).toEqual([]);
    expect(h.bankTx).toMatchObject({ status: 'MATCHED', paymentId: PAY });
  });

  // Bug #944: програвший гонку двох безготівкових сторно чув касове «Операцію вже сторновано».
  // guards: BR-PAY-024
  it('гонка: програвший CAS бачить «Оплату вже сторновано», а не касовий текст', async () => {
    const h = makeHarness({ bankTx: {} });
    const stale = { ...h.payment };
    let reads = 0;
    // Обидва читання до CAS (`reverseNonCash` і `reverse`) — «не сторновано»; перечитування після
    // програного CAS — уже сторнована оплата.
    h.tables.payment.findFirst.mockImplementation(() =>
      Promise.resolve(++reads <= 2 ? { ...stale } : { ...h.payment }),
    );
    h.payment.reversedAt = new Date('2026-10-21T10:00:00.000Z');
    const call = h.reverseNonCash();
    await expect(call).rejects.toThrow(uk('err.payment.alreadyReversed'));
    expect(h.settlementRows).toEqual([]);
  });

  // guards: BR-PAY-024
  it.each(['', '   '])('причина «%s» → 400 до транзакції', async reason => {
    const h = makeHarness();
    await expect(h.reverseNonCash(reason)).rejects.toThrow(BadRequestException);
    expect(h.transaction).not.toHaveBeenCalled();
    expectNothingWritten(h);
  });

  // guards: BR-PAY-024
  it('оплата іншої організації → 404, нічого не змінено', async () => {
    const h = makeHarness({ bankTx: {} });
    await expect(h.reverseNonCash(REASON, OTHER_ORG)).rejects.toThrow(NotFoundException);
    expectNothingWritten(h);
  });

  // guards: BR-PAY-024
  it('наряд оплати в архіві → 400 (відмова `reverse`), рядок виписки не чіпається', async () => {
    const h = makeHarness({ workOrder: { status: 'ARCHIVED' }, bankTx: {} });
    await expect(h.reverseNonCash()).rejects.toThrow(/в архіві/);
    expect(h.payment.reversedAt).toBeNull();
    expect(h.bankTx).toMatchObject({ status: 'MATCHED', paymentId: PAY });
  });
});

describe('PaymentsService.reverse — причина й автор і для касового сторно (BR-PAY-024 п. 5)', () => {
  // guards: BR-PAY-024, BR-CASH-024
  it('сторно з каси пише reversalReason / reversedBy; документ проводки — рядок сторно каси', async () => {
    const h = makeHarness({
      payment: { sourceType: 'CASH_REGISTER', cashRegisterId: 'cr-1', bankAccountId: null },
    });
    const STORNO_OP = 'e1000001-0000-4000-8000-000000000001';
    await h.service.reverse(
      ORG,
      PAY,
      { cashOperationId: STORNO_OP, reason: 'помилка касира', userId: USER },
      h.tx as never,
    );
    expect(h.payment).toMatchObject({
      reversalCashOperationId: STORNO_OP,
      reversalReason: 'помилка касира',
      reversedBy: USER,
    });
    expect(h.settlementRows[0]).toMatchObject({
      documentType: 'CashOperation',
      documentId: STORNO_OP,
    });
  });
});
