/**
 * SupplierPaymentsService — Payables FX (Фаза 5): курсові різниці
 *
 * Виділено з `supplier-payments.service.spec.ts` (був 1410 рядків: 1235 з них — ОДИН
 * top-level describe із 56 тестами БЕЗ вкладених describe, секції розмічені лише
 * ASCII-швами автора) 2026-10-07. Кейси перенесені ДОСЛІВНО.
 *
 * Сетап — `makeSpHarness()` з `./supplier-payments.spec-fixture` (той самий beforeEach).
 */

import { SupplierPaymentStatus, PaymentSourceType } from '@prisma/client';
import { vi, it, expect } from 'vitest';
import {
  makeSpHarness,
  type SpHarness,
  ORG,
  SP_ID,
  SUPPLIER_ID,
  USER_ID,
  confirmedRow,
} from './supplier-payments.spec-fixture';

describe('SupplierPaymentsService — payables-fx', () => {
  let service: SpHarness['service'];
  let prisma: SpHarness['prisma'];
  let settlements: SpHarness['settlements'];

  beforeEach(async () => {
    ({ service, prisma, settlements } = await makeSpHarness());
  });

  // ──────────────────────────────────────────────────────────────────────
  // Payables FX (Фаза 5) — курсові різниці постачальника при повній оплаті PO
  // ──────────────────────────────────────────────────────────────────────
  const PO_FX = '88888888-8888-4888-8888-888888888888';
  const USD = 'usd-1111-1111-1111-111111111111';
  const UAH = 'uah-2222-2222-2222-222222222222';

  // pre-read для confirm() USD-оплати привʼязаної до PO.
  const setupSpPre = (currencyId: string | null) =>
    prisma.supplierPayment.findFirst
      .mockResolvedValueOnce({
        status: SupplierPaymentStatus.DRAFT,
        supplierId: SUPPLIER_ID,
        amount: 100,
        sourceType: PaymentSourceType.BANK_ACCOUNT,
        cashRegisterId: null,
        currencyId,
        purchaseOrderId: PO_FX,
      })
      .mockResolvedValueOnce(confirmedRow); // findOne

  // Дефолтні exchangeRates мок — базова валюта (rate=1); FX-тести перевизначають base через getBaseCurrency.
  const setupPo = (poCurrencyId: string | null, totalAmount: number, paidAmount: number) =>
    prisma.purchaseOrder.findFirst.mockResolvedValue({
      currencyId: poCurrencyId,
      totalAmount,
      paidAmount,
      paidAt: null,
    });

  const fxCall = () =>
    settlements.createTransaction.mock.calls.find(
      c => c[1]?.type === 'FX_GAIN' || c[1]?.type === 'FX_LOSS',
    );

  it('крос-валюта: SP-валюта ≠ PO-валюта → 400 (валюта оплати == валюта PO)', async () => {
    setupSpPre(USD);
    setupPo(UAH, 100, 0); // PO у UAH, оплата у USD → розбіжність
    // base = UAH (id=UAH) → USD ≠ UAH-base → guard спрацьовує через sameCurrencyAsBase
    (
      service as unknown as { exchangeRates: { getBaseCurrency: ReturnType<typeof vi.fn> } }
    ).exchangeRates.getBaseCurrency = vi.fn().mockResolvedValue({ id: UAH, code: 'UAH' });
    await expect(service.confirm(ORG, SP_ID, USER_ID)).rejects.toThrow(
      /Валюта оплати має збігатися з валютою замовлення/,
    );
    expect(settlements.createTransaction).not.toHaveBeenCalled();
  });

  it('повна оплата USD-PO, chargeBase>paidBase → FX_GAIN (ІНВЕРСІЯ клієнта), balance→0', async () => {
    setupSpPre(USD);
    setupPo(USD, 100, 0); // повна оплата (100>=100)
    // base = UAH; PO у USD → не-base → FX-гілка активна.
    (
      service as unknown as { exchangeRates: { getBaseCurrency: ReturnType<typeof vi.fn> } }
    ).exchangeRates.getBaseCurrency = vi.fn().mockResolvedValue({ id: UAH, code: 'UAH' });
    // Нараховано 4200 base (курс прийому), сплачено 4150 base (курс оплати) → fx=+50.
    prisma.settlementTransaction.aggregate
      .mockResolvedValueOnce({ _sum: { amountBase: 4200 } }) // SUPPLIER_CHARGE
      .mockResolvedValueOnce({ _sum: { amountBase: 4150 } }); // SUPPLIER_PAYMENT
    prisma.supplierPayment.findMany.mockResolvedValue([{ id: SP_ID }]);

    await service.confirm(ORG, SP_ID, USER_ID);

    const call = fxCall();
    expect(call).toBeDefined();
    // fx=+50 → FX_GAIN (НЕ FX_LOSS як на клієнті!).
    expect(call![1]).toMatchObject({
      type: 'FX_GAIN',
      amount: 50,
      documentType: 'PurchaseOrder',
      documentId: PO_FX,
    });
    expect(call![1].currencyId).toBeUndefined();
    // paidAmount CAS оновив PO + paidAt виставлено (became fully paid).
    expect(prisma.purchaseOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paidAmount: 100, paidAt: expect.anything() }),
      }),
    );
  });

  it('повна оплата USD-PO, paidBase>chargeBase → FX_LOSS (ІНВЕРСІЯ)', async () => {
    setupSpPre(USD);
    setupPo(USD, 100, 0);
    (
      service as unknown as { exchangeRates: { getBaseCurrency: ReturnType<typeof vi.fn> } }
    ).exchangeRates.getBaseCurrency = vi.fn().mockResolvedValue({ id: UAH, code: 'UAH' });
    prisma.settlementTransaction.aggregate
      .mockResolvedValueOnce({ _sum: { amountBase: 4100 } }) // charge
      .mockResolvedValueOnce({ _sum: { amountBase: 4150 } }); // paid → fx=−50
    prisma.supplierPayment.findMany.mockResolvedValue([{ id: SP_ID }]);

    await service.confirm(ORG, SP_ID, USER_ID);
    expect(fxCall()![1]).toMatchObject({ type: 'FX_LOSS', amount: 50, documentId: PO_FX });
  });

  it('часткова оплата PO (не повна) → paidAmount інкремент, БЕЗ FX, paidAt null', async () => {
    setupSpPre(USD);
    setupPo(USD, 500, 0); // оплата 100 < 500 → часткова
    (
      service as unknown as { exchangeRates: { getBaseCurrency: ReturnType<typeof vi.fn> } }
    ).exchangeRates.getBaseCurrency = vi.fn().mockResolvedValue({ id: UAH, code: 'UAH' });
    await service.confirm(ORG, SP_ID, USER_ID);
    expect(fxCall()).toBeUndefined();
    expect(prisma.purchaseOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { paidAmount: 100 } }), // без paidAt
    );
  });

  it('idempotency: FX для PO вже проведено (count>0) → повторно НЕ бронюється', async () => {
    setupSpPre(USD);
    setupPo(USD, 100, 0);
    (
      service as unknown as { exchangeRates: { getBaseCurrency: ReturnType<typeof vi.fn> } }
    ).exchangeRates.getBaseCurrency = vi.fn().mockResolvedValue({ id: UAH, code: 'UAH' });
    prisma.settlementTransaction.aggregate.mockResolvedValue({ _sum: { amountBase: 4200 } });
    prisma.settlementTransaction.count.mockResolvedValue(1); // FX вже є
    prisma.supplierPayment.findMany.mockResolvedValue([{ id: SP_ID }]);
    await service.confirm(ORG, SP_ID, USER_ID);
    expect(fxCall()).toBeUndefined();
  });

  it('base-валютний PO повністю сплачено → FX НЕ бронюється', async () => {
    setupSpPre(UAH);
    setupPo(UAH, 100, 0);
    (
      service as unknown as { exchangeRates: { getBaseCurrency: ReturnType<typeof vi.fn> } }
    ).exchangeRates.getBaseCurrency = vi.fn().mockResolvedValue({ id: UAH, code: 'UAH' });
    await service.confirm(ORG, SP_ID, USER_ID);
    expect(fxCall()).toBeUndefined();
  });

  // Сценарій 2 (tester): остання часткова оплата робить PO повним → FX від Σ усіх платежів.
  it('часткові оплати: остання (200 з paidAmount=800, total=1000) робить повну оплату → FX, paidAmount CAS від po.paidAmount=800', async () => {
    // pre-read SP: amount=200 (не дефолтні 100), привʼязаний до PO_FX у USD.
    prisma.supplierPayment.findFirst
      .mockResolvedValueOnce({
        status: SupplierPaymentStatus.DRAFT,
        supplierId: SUPPLIER_ID,
        amount: 200,
        sourceType: PaymentSourceType.BANK_ACCOUNT,
        cashRegisterId: null,
        currencyId: USD,
        purchaseOrderId: PO_FX,
      })
      .mockResolvedValueOnce(confirmedRow); // findOne
    // PO: total=1000, вже сплачено 800 (попередні часткові), paidAt ще null.
    prisma.purchaseOrder.findFirst.mockResolvedValue({
      currencyId: USD,
      totalAmount: 1000,
      paidAmount: 800,
      paidAt: null,
    });
    (
      service as unknown as { exchangeRates: { getBaseCurrency: ReturnType<typeof vi.fn> } }
    ).exchangeRates.getBaseCurrency = vi.fn().mockResolvedValue({ id: UAH, code: 'UAH' });
    // chargeBase = Σ усіх SUPPLIER_CHARGE = 42000; paidBase = Σ усіх SUPPLIER_PAYMENT = 41900 → fx=+100.
    prisma.settlementTransaction.aggregate
      .mockResolvedValueOnce({ _sum: { amountBase: 42000 } }) // charge
      .mockResolvedValueOnce({ _sum: { amountBase: 41900 } }); // paid (усі 5 платежів)
    prisma.supplierPayment.findMany.mockResolvedValue([
      { id: 'sp-1' },
      { id: 'sp-2' },
      { id: 'sp-3' },
      { id: 'sp-4' },
      { id: SP_ID },
    ]);

    await service.confirm(ORG, SP_ID, USER_ID);

    // FX від Σ (не лише останнього платежу): fx=+100 → FX_GAIN (інверсія клієнта).
    expect(fxCall()![1]).toMatchObject({ type: 'FX_GAIN', amount: 100, documentId: PO_FX });
    // paidAmount CAS: 800+200=1000, where paidAmount=800 (снапшот), paidAt виставлено.
    expect(prisma.purchaseOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ paidAmount: 800 }),
        data: expect.objectContaining({ paidAmount: 1000, paidAt: expect.anything() }),
      }),
    );
  });

  // Сценарій 6 (tester): overpay-повтор після повної оплати → paidAt вже set → БЕЗ другого FX.
  it('повторна оплата після повної (paidAt≠null) → paidAmount інкремент, БЕЗ другого FX', async () => {
    setupSpPre(USD);
    // PO вже повністю сплачено раніше: paidAmount=100=total, paidAt виставлено.
    prisma.purchaseOrder.findFirst.mockResolvedValue({
      currencyId: USD,
      totalAmount: 100,
      paidAmount: 100,
      paidAt: new Date('2026-09-01'),
    });
    (
      service as unknown as { exchangeRates: { getBaseCurrency: ReturnType<typeof vi.fn> } }
    ).exchangeRates.getBaseCurrency = vi.fn().mockResolvedValue({ id: UAH, code: 'UAH' });
    prisma.settlementTransaction.aggregate.mockResolvedValue({ _sum: { amountBase: 4200 } });
    prisma.supplierPayment.findMany.mockResolvedValue([{ id: SP_ID }]);

    await service.confirm(ORG, SP_ID, USER_ID);

    // becameFullyPaid = false (paidAt != null) → жодного FX навіть за наявної base-різниці.
    expect(fxCall()).toBeUndefined();
    // paidAmount все одно інкрементиться (overpay без cap), БЕЗ перезапису paidAt.
    expect(prisma.purchaseOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { paidAmount: 200 } }),
    );
  });

  // Сценарій 8 (tester): paidAmount CAS програв гонку (count=0) → 400, весь confirm відкат.
  it('concurrency: paidAmount CAS count=0 (паралельна оплата) → 400', async () => {
    setupSpPre(USD);
    setupPo(USD, 100, 0);
    (
      service as unknown as { exchangeRates: { getBaseCurrency: ReturnType<typeof vi.fn> } }
    ).exchangeRates.getBaseCurrency = vi.fn().mockResolvedValue({ id: UAH, code: 'UAH' });
    // SP CAS (confirm) успішний, але paidAmount CAS програв (інша оплата змінила paidAmount).
    prisma.purchaseOrder.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.confirm(ORG, SP_ID, USER_ID)).rejects.toThrow(
      /Замовлення змінено паралельною операцією/,
    );
    expect(fxCall()).toBeUndefined();
  });

  // Сценарій 4 (tester): SP без purchaseOrderId → без guard/без FX/без paidAmount (не ламається).
  it('SP без purchaseOrderId → confirm без guard/FX/paidAmount tracking', async () => {
    prisma.supplierPayment.findFirst
      .mockResolvedValueOnce({
        status: SupplierPaymentStatus.DRAFT,
        supplierId: SUPPLIER_ID,
        amount: 100,
        sourceType: PaymentSourceType.BANK_ACCOUNT,
        cashRegisterId: null,
        currencyId: USD,
        purchaseOrderId: null,
      })
      .mockResolvedValueOnce(confirmedRow);
    await service.confirm(ORG, SP_ID, USER_ID);
    // SUPPLIER_PAYMENT settlement пишеться, але жодного paidAmount CAS / FX.
    expect(prisma.purchaseOrder.findFirst).not.toHaveBeenCalled();
    expect(prisma.purchaseOrder.updateMany).not.toHaveBeenCalled();
    expect(fxCall()).toBeUndefined();
    expect(
      settlements.createTransaction.mock.calls.some(c => c[1]?.type === 'SUPPLIER_PAYMENT'),
    ).toBe(true);
  });
});
