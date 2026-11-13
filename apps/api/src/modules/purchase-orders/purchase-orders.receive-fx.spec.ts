/**
 * Курсова різниця передоплаченого валютного замовлення — при прийомі (BR-SUPPAY-018, TECH-DEBT (б)
 * №91 а). Прийом, що переводить ПОВНІСТЮ сплачене валютне замовлення в «Отримано», у тій самій
 * транзакції визнає FX тією ж функцією, що проведення оплати (`recognizeSupplierOrderFxInTx`):
 * `fx = Σ SUPPLIER_CHARGE.amountBase − Σ SUPPLIER_PAYMENT.amountBase`, FX_GAIN / FX_LOSS у базовій
 * валюті на документ-замовлення. Порядок «оплата → прийом» і «прийом → оплата» дає ту саму суму.
 *
 * Обидва сервіси (`PurchaseOrdersService`, `SupplierPaymentsService`) працюють над ОДНИМИ таблицями
 * в пам'яті (`memoryTable`, `where` виконується), а мок проводок пише рядок журналу з базовою сумою —
 * тож агрегати функції FX бачать справжні проводки прийому й оплати.
 *
 * Mutation-verify (2026-11-13): прибрати виклик `recognizeSupplierOrderFxInTx` у `receive` →
 * «передоплачене … FX_GAIN» і «та сама сума в обох порядках» червоні; прибрати умову `paidAt` →
 * «неповна оплата» червоний; прибрати ранній вихід за чистою FX → «уже визнано» червоний.
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { PurchaseOrdersService } from './purchase-orders.service';
import { exchangeRatesProvider, purchaseListProviders } from './purchase-orders.spec-fixture';
import { SupplierPaymentsService } from '../supplier-payments/supplier-payments.service';
import { memoryTable, type MemRow } from '../cash/cash.spec-fixture';
import type { PrismaService } from '../../prisma/prisma.service';
import type { InventoryService } from '../inventory/inventory.service';
import type { SettlementsService } from '../settlements/settlements.service';
import type { DocumentNumberService } from '../document-number/document-number.service';
import type { PricingService } from '../inventory/pricing.service';
import type { SettingsService } from '../settings/settings.service';
import type { DeliveryTrackingService } from './delivery/delivery-tracking.service';
import type { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';
import type { PurchaseListLinkService } from '../purchase-lists/purchase-list-link.service';
import type { PurchaseListReceiptService } from '../purchase-lists/purchase-list-receipt.service';
import type { SupplierOrderOutboxService } from '../supplier-api/outbox/supplier-order-outbox.service';
import type { CashService } from '../cash/cash.service';

const ORG = '00000000-0000-4000-8000-000000000001';
const PO = '55555555-5555-4555-8555-555555555555';
const LINE_A = '66666666-6666-4666-8666-666666666661';
const LINE_B = '66666666-6666-4666-8666-666666666662';
const SUPPLIER = '22222222-2222-4222-8222-222222222222';
const SP_PAID = '11111111-1111-4111-8111-111111111111';
const SP_DRAFT = '11111111-1111-4111-8111-111111111112';
const USER = '77777777-7777-4777-8777-777777777777';
const USD = 'usd-id';
const BASE = 'uah-id';

/** Курс прийому (нарахування) і курс оплати: 100 USD → 4200 і 4100 грн. */
const RATE_RECEIVE = 42;
const RATE_PAY = 41;

interface Seed {
  po?: MemRow;
  /** Проведена оплата до прийому (передоплата): сума у валюті замовлення; null — оплати немає. */
  prepaid?: number | null;
  journal?: MemRow[];
  rateReceive?: number;
}

function makeHarness(seed: Seed = {}) {
  const prepaid = seed.prepaid === undefined ? 100 : seed.prepaid;
  const currencyId = (seed.po?.currencyId as string | undefined) ?? USD;
  const po: MemRow = {
    id: PO,
    orgId: ORG,
    number: 'ЗП-FX-1',
    status: 'ORDERED',
    supplierId: SUPPLIER,
    warehouseId: 'wh-1',
    currencyId,
    totalAmount: 100,
    paidAmount: prepaid ?? 0,
    paidAt: prepaid != null && prepaid >= 100 ? new Date('2026-11-10T00:00:00.000Z') : null,
    paymentDate: null,
    contractId: null,
    deletedAt: null,
    ...seed.po,
  };
  // Два рядки: 1 шт × 60 і 2 шт × 20 = 100 USD.
  const lines = memoryTable([
    {
      id: LINE_A,
      orgId: ORG,
      purchaseOrderId: PO,
      goodId: 'g-a',
      quantity: 1,
      receivedQty: 0,
      price: 60,
      deletedAt: null,
      good: { unitId: null },
    },
    {
      id: LINE_B,
      orgId: ORG,
      purchaseOrderId: PO,
      goodId: 'g-b',
      quantity: 2,
      receivedQty: 0,
      price: 20,
      deletedAt: null,
      good: { unitId: null },
    },
  ]);
  const payments: MemRow[] = [];
  const journal: MemRow[] = [...(seed.journal ?? [])];
  if (prepaid != null) {
    payments.push({
      id: SP_PAID,
      orgId: ORG,
      number: 'ОПП-1',
      status: 'CONFIRMED',
      supplierId: SUPPLIER,
      purchaseOrderId: PO,
      sourceType: 'BANK_ACCOUNT',
      bankAccountId: 'ba-1',
      cashRegisterId: null,
      amount: prepaid,
      currencyId,
      deletedAt: null,
    });
    journal.push({
      id: 'st-pay',
      orgId: ORG,
      type: 'SUPPLIER_PAYMENT',
      amount: prepaid,
      amountBase: currencyId === BASE ? prepaid : prepaid * RATE_PAY,
      currencyId,
      documentType: 'SupplierPayment',
      documentId: SP_PAID,
    });
  }
  const tables = {
    domainEvent: memoryTable([]),
    purchaseOrder: memoryTable([po], () => ({}), {
      lines: () => lines.rows.filter(l => l.purchaseOrderId === PO && l.deletedAt == null),
      contract: () => null,
    }),
    purchaseOrderLine: lines,
    supplierPayment: memoryTable(payments),
    settlementTransaction: memoryTable(journal),
    unitOfMeasure: memoryTable([]),
    goodUoM: memoryTable([]),
  };
  const root = {
    ...tables,
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(tables)),
  };

  const rateReceive = seed.rateReceive ?? RATE_RECEIVE;
  const settlements = {
    // Мок проводки пише рядок журналу з базовою сумою: SUPPLIER_CHARGE валютного замовлення — за
    // курсом прийому, оплата — за переданою конвертацією, FX — у базовій валюті (без currencyId).
    createTransaction: vi.fn((orgId: string, dto: MemRow) => {
      const conversion = dto.conversion as { amountBase: number } | undefined;
      const amount = Number(dto.amount);
      const amountBase = conversion
        ? conversion.amountBase
        : dto.currencyId && dto.currencyId !== BASE
          ? amount * rateReceive
          : amount;
      tables.settlementTransaction.rows.push({
        id: `st-${journal.length + 1}`,
        orgId,
        ...dto,
        amountBase,
      });
      return Promise.resolve();
    }),
  };
  const fxRows = () =>
    tables.settlementTransaction.rows.filter(r => r.type === 'FX_GAIN' || r.type === 'FX_LOSS');

  const exchangeRates = exchangeRatesProvider().useValue;
  exchangeRates.getBaseCurrency.mockResolvedValue({ id: BASE, code: 'UAH' });
  exchangeRates.resolveBaseConversion.mockImplementation(
    (_o: string, cur: string, _d: Date, amount: number) =>
      Promise.resolve(
        cur === BASE
          ? { rateUsed: 1, amountBase: amount }
          : { rateUsed: RATE_PAY, amountBase: amount * RATE_PAY },
      ),
  );
  const [linkProvider, receiptProvider, outboxProvider] = purchaseListProviders();

  const poService = new PurchaseOrdersService(
    root as unknown as PrismaService,
    { createMovement: vi.fn().mockResolvedValue(undefined) } as unknown as InventoryService,
    settlements as unknown as SettlementsService,
    {} as unknown as DocumentNumberService,
    {} as unknown as PricingService,
    {} as unknown as SettingsService,
    {} as unknown as DeliveryTrackingService,
    exchangeRates as unknown as ExchangeRatesService,
    linkProvider.useValue as unknown as PurchaseListLinkService,
    receiptProvider.useValue as unknown as PurchaseListReceiptService,
    outboxProvider.useValue as unknown as SupplierOrderOutboxService,
  );
  // Відповідь прийому (картка з рядками й підписами) — не предмет цього спеку.
  vi.spyOn(poService, 'findOne').mockResolvedValue({ id: PO } as never);

  const spService = new SupplierPaymentsService(
    root as unknown as PrismaService,
    settlements as unknown as SettlementsService,
    { next: vi.fn() } as unknown as DocumentNumberService,
    { createOperation: vi.fn() } as unknown as CashService,
    exchangeRates as unknown as ExchangeRatesService,
  );

  const receiveAll = () =>
    poService.receive(
      ORG,
      PO,
      {
        lines: [
          { lineId: LINE_A, receivedQty: 1 },
          { lineId: LINE_B, receivedQty: 2 },
        ],
      },
      USER,
    );

  /** «Прийом → оплата»: чернетка на всю суму, провести після прийому. */
  const confirmDraft = (amount = 100) => {
    tables.supplierPayment.rows.push({
      id: SP_DRAFT,
      orgId: ORG,
      number: 'ОПП-2',
      status: 'DRAFT',
      supplierId: SUPPLIER,
      purchaseOrderId: PO,
      sourceType: 'BANK_ACCOUNT',
      bankAccountId: 'ba-1',
      cashRegisterId: null,
      amount,
      currencyId,
      method: 'bank_transfer',
      notes: null,
      documentDate: new Date('2026-11-12T00:00:00.000Z'),
      createdAt: new Date('2026-11-12T00:00:00.000Z'),
      updatedAt: new Date('2026-11-12T00:00:00.000Z'),
      deletedAt: null,
    });
    return spService.confirm(ORG, SP_DRAFT, USER);
  };

  return {
    tables,
    root,
    settlements,
    exchangeRates,
    poService,
    receiveAll,
    confirmDraft,
    fxRows,
    po,
  };
}

describe('PurchaseOrdersService.receive — курсова різниця передоплати (BR-SUPPAY-018)', () => {
  // guards: BR-SUPPAY-018
  it('передоплачене валютне замовлення → «Отримано» → FX_GAIN на різницю нараховано − сплачено', async () => {
    const h = makeHarness();

    await h.receiveAll();

    expect(h.po.status).toBe('RECEIVED');
    expect(h.fxRows()).toEqual([
      expect.objectContaining({
        type: 'FX_GAIN',
        amount: 100, // 4200 (прийом за 42) − 4100 (оплата за 41)
        counterpartyId: SUPPLIER,
        documentType: 'PurchaseOrder',
        documentId: PO,
        createdBy: USER,
      }),
    ]);
    // Базова дельта: без валюти.
    expect(h.fxRows()[0]!.currencyId).toBeUndefined();
  });

  // guards: BR-SUPPAY-018
  it('сплачено в базовій валюті більше, ніж нараховано → FX_LOSS', async () => {
    const h = makeHarness({ rateReceive: 40 });

    await h.receiveAll();

    expect(h.fxRows()).toEqual([expect.objectContaining({ type: 'FX_LOSS', amount: 100 })]);
  });

  // guards: BR-SUPPAY-018
  it('у транзакції прийому, після SUPPLIER_CHARGE і запису статусу', async () => {
    const h = makeHarness();

    await h.receiveAll();

    const calls = h.settlements.createTransaction.mock.calls.map(c => (c[1] as MemRow).type);
    expect(calls).toEqual(['SUPPLIER_CHARGE', 'FX_GAIN']);
    const [chargeOrder, fxOrder] = h.settlements.createTransaction.mock.invocationCallOrder;
    const statusOrder = h.tables.purchaseOrder.updateMany.mock.invocationCallOrder[0]!;
    expect(chargeOrder).toBeLessThan(statusOrder);
    expect(statusOrder).toBeLessThan(fxOrder!);
    expect(h.root.$transaction).toHaveBeenCalledTimes(1);
  });

  // Валюта бази читається через `this.prisma` — у транзакції це друге з'єднання пулу.
  // guards: BR-SUPPAY-018
  it('валюту бази звірено ДО транзакції прийому', async () => {
    const h = makeHarness();

    await h.receiveAll();

    const [sameCurrencyOrder] = h.exchangeRates.sameCurrency.mock.invocationCallOrder;
    const [txOrder] = h.root.$transaction.mock.invocationCallOrder;
    expect(sameCurrencyOrder).toBeLessThan(txOrder!);
  });

  // guards: BR-SUPPAY-018, BR-SUPPAY-012
  it('«оплата → прийом» і «прийом → оплата» дають ту саму курсову різницю', async () => {
    const prepaidFirst = makeHarness();
    await prepaidFirst.receiveAll();

    const receivedFirst = makeHarness({ prepaid: null });
    await receivedFirst.receiveAll();
    expect(receivedFirst.fxRows()).toEqual([]); // ще не сплачено — FX немає
    await receivedFirst.confirmDraft();

    const pick = (rows: MemRow[]) => rows.map(r => ({ type: r.type, amount: Number(r.amount) }));
    expect(pick(receivedFirst.fxRows())).toEqual([{ type: 'FX_GAIN', amount: 100 }]);
    expect(pick(prepaidFirst.fxRows())).toEqual(pick(receivedFirst.fxRows()));
  });

  // guards: BR-SUPPAY-018
  it('частковий прийом («Частково») → FX немає', async () => {
    const h = makeHarness();

    await h.poService.receive(ORG, PO, { lines: [{ lineId: LINE_A, receivedQty: 1 }] }, USER);

    expect(h.po.status).toBe('PARTIAL');
    expect(h.fxRows()).toEqual([]);
  });

  // guards: BR-SUPPAY-018
  it('неповна оплата (paidAt немає) → FX немає', async () => {
    const h = makeHarness({ prepaid: 50 });

    await h.receiveAll();

    expect(h.po.status).toBe('RECEIVED');
    expect(h.fxRows()).toEqual([]);
  });

  // guards: BR-SUPPAY-018
  it('замовлення в базовій валюті → FX немає', async () => {
    const h = makeHarness({ po: { currencyId: BASE } });

    await h.receiveAll();

    expect(h.po.status).toBe('RECEIVED');
    expect(h.fxRows()).toEqual([]);
  });

  // Переплата в базовій валюті — не курсова різниця: без перевірки валюти «нараховано − сплачено»
  // дало б FX_LOSS на суму переплати (і в прийомі, і в проведенні).
  // guards: BR-SUPPAY-018, BR-SUPPAY-012
  it('базова валюта з переплатою: ні прийом, ні проведення FX не пишуть', async () => {
    const prepaidFirst = makeHarness({ po: { currencyId: BASE, paidAmount: 120 }, prepaid: 120 });
    await prepaidFirst.receiveAll();
    expect(prepaidFirst.fxRows()).toEqual([]);

    const receivedFirst = makeHarness({ po: { currencyId: BASE }, prepaid: null });
    await receivedFirst.receiveAll();
    await receivedFirst.confirmDraft(120);
    expect(receivedFirst.po.paidAt).not.toBeNull();
    expect(receivedFirst.fxRows()).toEqual([]);
  });

  // guards: BR-SUPPAY-018
  it('чиста FX замовлення вже ≠ 0 → другої курсової різниці не пише', async () => {
    const h = makeHarness({
      journal: [
        {
          id: 'st-fx-old',
          orgId: ORG,
          type: 'FX_GAIN',
          amount: 100,
          amountBase: 100,
          documentType: 'PurchaseOrder',
          documentId: PO,
        },
      ],
    });

    await h.receiveAll();

    expect(h.fxRows()).toHaveLength(1);
    expect(h.settlements.createTransaction.mock.calls.map(c => (c[1] as MemRow).type)).toEqual([
      'SUPPLIER_CHARGE',
    ]);
  });

  // guards: BR-SUPPAY-018
  it('повторний прийом отриманого замовлення → 400, FX не дублюється', async () => {
    const h = makeHarness();
    await h.receiveAll();

    await expect(h.receiveAll()).rejects.toThrow(BadRequestException);

    expect(h.fxRows()).toHaveLength(1);
  });
});
