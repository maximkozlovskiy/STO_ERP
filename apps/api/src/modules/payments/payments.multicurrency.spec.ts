/**
 * PaymentsService — мультивалюта Фаза 2 + FX
 *
 * Виділено з `payments.service.spec.ts` (був 1720 рядків, 5 незалежних top-level
 * describe) 2026-10-06. Кейси перенесені ДОСЛІВНО, назви describe не змінені —
 * інакше `fullName` у test-baseline.json розійшовся б.
 *
 * Цей аспект НЕ бере `exchangeRatesMock()` з фікстури: мультивалютні тести будують
 * власний мок із типізованими `Mock<...>`-полями, бо перевизначають getBaseCurrency
 * у межах окремих кейсів.
 */

import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SettlementsService } from '../settlements/settlements.service';
import { CashService } from '../cash/cash.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WorkOrdersService } from '../work-orders/work-orders.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { AuditService } from '../audit/audit.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';

describe('PaymentsService — мультивалюта Фаза 2 (Payment currencyId/amountBase + fiscal-UAH guard)', () => {
  let service: PaymentsService;
  let prisma: Record<string, Record<string, ReturnType<typeof vi.fn>>> & {
    $transaction: ReturnType<typeof vi.fn>;
  };
  let settlements: { createTransaction: ReturnType<typeof vi.fn> };
  let loyalty: { queueEarn: ReturnType<typeof vi.fn> };
  let cash: { createOperation: ReturnType<typeof vi.fn> };
  let exchangeRates: {
    resolveBaseConversion: ReturnType<typeof vi.fn>;
    // Конкретна сигнатура: безпараметричний ReturnType<typeof vi.fn> у TS 6 + Vitest 5
    // виводиться як `Mock<Procedure | Constructable>` і вже не викликається без `new`
    // (TS2348) — а цей мок викликають усередині sameCurrency.
    getBaseCurrency: Mock<(orgId: string) => Promise<{ id: string | null; code: string }>>;
    sameCurrency: ReturnType<typeof vi.fn>;
  };
  let checkboxQueue: { add: ReturnType<typeof vi.fn> };
  let lastCreateData: Record<string, unknown> | undefined;

  const ORG = 'org-1';
  const CP_ID = '22222222-2222-4222-8222-222222222222';
  const PAY_ID = '44444444-4444-4444-8444-444444444444';
  const CASH_ID = '66666666-6666-4666-8666-666666666666';
  const USD_ID = '77777777-7777-4777-8777-777777777777';
  const UAH_ID = '88888888-8888-4888-8888-888888888888';

  beforeEach(async () => {
    lastCreateData = undefined;
    prisma = {
      counterparty: {
        findFirst: vi.fn().mockResolvedValue({
          id: CP_ID,
          phone: null,
          email: null,
          firstName: null,
          lastName: null,
          companyName: 'ТОВ',
        }),
      },
      workOrder: { findFirst: vi.fn(), update: vi.fn() },
      invoice: { findFirst: vi.fn(), updateMany: vi.fn() },
      garageBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'br-1' }) },
      payment: {
        create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          lastCreateData = args.data;
          return Promise.resolve({
            id: PAY_ID,
            orgId: ORG,
            counterpartyId: CP_ID,
            workOrderId: null,
            invoiceId: null,
            amount: 100,
            method: 'cash',
            notes: null,
            fiscalReceiptId: null,
            fiscalStatus: args.data.fiscalStatus ?? null,
            fiscalError: null,
            currencyId: args.data.currencyId ?? null,
            amountBase: args.data.amountBase ?? null,
            rateUsed: args.data.rateUsed ?? null,
            currency: null,
            createdAt: new Date(),
            counterparty: { firstName: null, lastName: null, companyName: 'ТОВ' },
          });
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      paymentMethodConfig: { findFirst: vi.fn().mockResolvedValue({ requiresFiscal: false }) },
      bankAccount: { findFirst: vi.fn() },
      cashRegister: { findFirst: vi.fn() },
      $transaction: vi.fn().mockImplementation(async (arg: unknown) => {
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return undefined;
      }),
    } as never;
    // Курсові різниці (Фаза 4): FX-хук агрегує CHARGE (леджер) + Payment.amountBase + count наявних FX.
    // Default: chargeBase===paidBase===0 (fx=0 → FX не бронюється), count=0. FX-тести перевизначають.
    (
      prisma as never as Record<string, Record<string, ReturnType<typeof vi.fn>>>
    ).settlementTransaction = {
      aggregate: vi.fn().mockResolvedValue({ _sum: { amountBase: 0 } }),
      count: vi.fn().mockResolvedValue(0),
    };
    (
      prisma as never as Record<string, Record<string, ReturnType<typeof vi.fn>>>
    ).payment.aggregate = vi.fn().mockResolvedValue({ _sum: { amountBase: 0 } });
    settlements = { createTransaction: vi.fn() };
    loyalty = { queueEarn: vi.fn().mockResolvedValue(undefined) };
    cash = { createOperation: vi.fn().mockResolvedValue(undefined) };
    checkboxQueue = { add: vi.fn().mockResolvedValue(undefined) };
    exchangeRates = {
      resolveBaseConversion: vi.fn(),
      getBaseCurrency: vi.fn().mockResolvedValue({ id: UAH_ID, code: 'UAH' }),
      sameCurrency: vi.fn(async (org: string, a: string | null, b: string | null) => {
        if (a === b) return true;
        const baseId = (await exchangeRates.getBaseCurrency(org)).id;
        const norm = (v: string | null) => v ?? baseId;
        return norm(a) === norm(b);
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettlementsService, useValue: settlements },
        { provide: NotificationsService, useValue: { send: vi.fn().mockResolvedValue(undefined) } },
        {
          provide: WorkOrdersService,
          useValue: { transition: vi.fn().mockResolvedValue(undefined) },
        },
        { provide: LoyaltyService, useValue: loyalty },
        { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        { provide: CashService, useValue: cash },
        { provide: ExchangeRatesService, useValue: exchangeRates },
        { provide: getQueueToken('checkbox'), useValue: checkboxQueue },
      ],
    }).compile();
    service = module.get(PaymentsService);
  });

  const usdCashDto = {
    counterpartyId: CP_ID,
    amount: 100,
    method: 'cash',
    sourceType: 'CASH_REGISTER' as const,
    cashRegisterId: CASH_ID,
  };

  it('оплата у USD-касу → payment пише currencyId/amountBase/rateUsed по курсу; settlement отримує currencyId', async () => {
    prisma.cashRegister.findFirst.mockResolvedValue({
      id: CASH_ID,
      isFiscal: false,
      currencyId: USD_ID,
    });
    // 100 USD × 41.50 = 4150 UAH base.
    exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 41.5, amountBase: 4150 });

    await service.create(ORG, usdCashDto, 'user-1');

    expect(exchangeRates.resolveBaseConversion).toHaveBeenCalledWith(
      ORG,
      USD_ID,
      expect.any(Date),
      100,
    );
    expect(lastCreateData?.currencyId).toBe(USD_ID);
    expect(lastCreateData?.amountBase).toBe(4150);
    expect(lastCreateData?.rateUsed).toBe(41.5);
    // Борг у base: settlement отримує currencyId (createTransaction сам конвертує).
    expect(settlements.createTransaction).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ type: 'PAYMENT', amount: 100, currencyId: USD_ID }),
      expect.anything(),
    );
  });

  it('loyalty нараховує від amountBase (base), не від dto.amount', async () => {
    prisma.cashRegister.findFirst.mockResolvedValue({
      id: CASH_ID,
      isFiscal: false,
      currencyId: USD_ID,
    });
    exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 41.5, amountBase: 4150 });

    await service.create(ORG, usdCashDto, 'user-1');

    expect(loyalty.queueEarn).toHaveBeenCalledWith(ORG, CP_ID, 4150, PAY_ID);
  });

  it('фіскальна каса у НЕ-базовій валюті (USD) → 400, без payment.create/settlement', async () => {
    prisma.cashRegister.findFirst.mockResolvedValue({
      id: CASH_ID,
      isFiscal: true, // фіскальна → willFiscalize=true
      currencyId: USD_ID,
    });
    exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 41.5, amountBase: 4150 });

    await expect(service.create(ORG, usdCashDto, 'user-1')).rejects.toThrow(/базовій валюті/);
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(settlements.createTransaction).not.toHaveBeenCalled();
    expect(checkboxQueue.add).not.toHaveBeenCalled();
  });

  it('фіскальна каса у БАЗОВІЙ валюті (currencyId == base) → успіх, чек ставиться', async () => {
    prisma.cashRegister.findFirst.mockResolvedValue({
      id: CASH_ID,
      isFiscal: true,
      currencyId: UAH_ID, // == base
    });
    exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 1, amountBase: 100 });

    await service.create(ORG, usdCashDto, 'user-1');

    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(lastCreateData?.fiscalStatus).toBe('QUEUED');
    expect(checkboxQueue.add).toHaveBeenCalledTimes(1);
  });

  it('оплата без рахунку (source=null) → base (rate=1, amountBase=amount), resolveBaseConversion не викликається', async () => {
    // Метод без дефолтного рахунку → resolvedSource.currencyId undefined → base.
    await service.create(ORG, { counterpartyId: CP_ID, amount: 100, method: 'cash' }, 'user-1');

    expect(exchangeRates.resolveBaseConversion).not.toHaveBeenCalled();
    expect(lastCreateData?.currencyId).toBeNull();
    expect(lastCreateData?.amountBase).toBe(100);
    expect(lastCreateData?.rateUsed).toBe(1);
    expect(loyalty.queueEarn).toHaveBeenCalledWith(ORG, CP_ID, 100, PAY_ID);
  });

  // ── Мультивалюта Фаза 3: оплата документа у ВАЛЮТІ документа ──────────
  // Модель змінилась (Фаза 3): Invoice.amount/paidAmount тепер у ВАЛЮТІ рахунку; оплата МУСИТЬ бути
  // у тій самій валюті → overpay-guard і paidAmount порівнюються/накопичуються у dto.amount (валюта),
  // борг у леджері лягає у base через settlement. Крос-валютна оплата → 400.
  const INV_ID_MC = '99999999-9999-4999-8999-999999999999';

  it('оплата USD-інвойсу з USD-каси: overpay-guard у ВАЛЮТІ (dto.amount > залишку → 400)', async () => {
    prisma.cashRegister.findFirst.mockResolvedValue({
      id: CASH_ID,
      isFiscal: false,
      currencyId: USD_ID,
    });
    // Рахунок у USD, залишок = 90 USD; платіж 100 USD > 90 → переплата (у валюті рахунку).
    prisma.invoice.findFirst.mockResolvedValue({
      counterpartyId: CP_ID,
      status: 'SENT',
      workOrderId: null,
      amount: 90,
      paidAmount: 0,
      currencyId: USD_ID,
    });
    exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 41.5, amountBase: 4150 });

    await expect(
      service.create(ORG, { ...usdCashDto, invoiceId: INV_ID_MC }, 'user-1'),
    ).rejects.toThrow(/перевищує залишок/);
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('оплата USD-інвойсу з USD-каси: paidAmount інкрементиться dto.amount (валюта), не amountBase', async () => {
    prisma.cashRegister.findFirst.mockResolvedValue({
      id: CASH_ID,
      isFiscal: false,
      currencyId: USD_ID,
    });
    // Рахунок 100 USD, залишок 100; платіж 100 USD → рівно закриває → PAID (у валюті).
    prisma.invoice.findFirst.mockResolvedValue({
      counterpartyId: CP_ID,
      status: 'SENT',
      workOrderId: null,
      amount: 100,
      paidAmount: 0,
      currencyId: USD_ID,
    });
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
    exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 41.5, amountBase: 4150 });

    await service.create(ORG, { ...usdCashDto, invoiceId: INV_ID_MC }, 'user-1');

    // paidAmount у валюті рахунку (100), status PAID; settlement окремо конвертує у base.
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paidAmount: 100, status: 'PAID' }),
      }),
    );
  });

  it('крос-валюта: оплата з USD-каси у base-інвойс → 400 (валюти мають збігатися)', async () => {
    prisma.cashRegister.findFirst.mockResolvedValue({
      id: CASH_ID,
      isFiscal: false,
      currencyId: USD_ID,
    });
    // Рахунок у базовій валюті (currencyId=UAH_ID), оплата з USD-каси → розбіжність валют.
    prisma.invoice.findFirst.mockResolvedValue({
      counterpartyId: CP_ID,
      status: 'SENT',
      workOrderId: null,
      amount: 100,
      paidAmount: 0,
      currencyId: UAH_ID,
    });
    exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 41.5, amountBase: 4150 });

    await expect(
      service.create(ORG, { ...usdCashDto, invoiceId: INV_ID_MC }, 'user-1'),
    ).rejects.toThrow(/Валюта оплати має збігатися/);
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-005
  it('оплата USD-наряду з USD-каси: WorkOrder.paidAmount інкрементиться dto.amount (валюта наряду)', async () => {
    const WO_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    prisma.cashRegister.findFirst.mockResolvedValue({
      id: CASH_ID,
      isFiscal: false,
      currencyId: USD_ID,
    });
    // Наряд у USD (валюта оплати == валюта наряду) → guard пропускає.
    prisma.workOrder.findFirst.mockResolvedValue({
      branchId: 'br-1',
      status: 'INVOICED',
      currencyId: USD_ID,
    });
    prisma.workOrder.update.mockResolvedValue({});
    exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 41.5, amountBase: 4150 });

    await service.create(ORG, { ...usdCashDto, workOrderId: WO_ID }, 'user-1');

    // WO.paidAmount у валюті наряду → інкремент dto.amount (100), не amountBase (4150).
    expect(prisma.workOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { paidAmount: { increment: 100 } },
      }),
    );
  });

  it('крос-валюта: оплата з USD-каси у base-наряд (без invoiceId) → 400 (валюти мають збігатися) [Bug #744]', async () => {
    const WO_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    prisma.cashRegister.findFirst.mockResolvedValue({
      id: CASH_ID,
      isFiscal: false,
      currencyId: USD_ID,
    });
    // Наряд у базовій валюті (currencyId=null≡UAH), оплата з USD-каси → розбіжність валют.
    // Без цього guard WO.paidAmount (у валюті наряду=UAH) інкрементився б на 100 USD → змішування одиниць.
    prisma.workOrder.findFirst.mockResolvedValue({
      branchId: 'br-1',
      status: 'INVOICED',
      currencyId: null,
    });
    exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 41.5, amountBase: 4150 });

    await expect(
      service.create(ORG, { ...usdCashDto, workOrderId: WO_ID }, 'user-1'),
    ).rejects.toThrow(/Валюта оплати має збігатися з валютою наряду/);
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.workOrder.update).not.toHaveBeenCalled();
  });

  // ── Курсові різниці (Фаза 4): realized FX при повній оплаті іновалютного рахунку ──────────
  const INV_FX = '99999999-9999-4999-8999-999999999999';

  // Хелпер: повна оплата USD-інвойсу (стає PAID) з заданими chargeBase (леджер) і paidBase (Payment agg).
  const setupFxInvoicePaid = (chargeBase: number, paidBase: number, existingFx = 0) => {
    prisma.cashRegister.findFirst.mockResolvedValue({
      id: CASH_ID,
      isFiscal: false,
      currencyId: USD_ID,
    });
    prisma.invoice.findFirst.mockResolvedValue({
      counterpartyId: CP_ID,
      id: INV_FX,
      status: 'SENT',
      workOrderId: null,
      amount: 100,
      paidAmount: 0,
      currencyId: USD_ID, // != base → FX-гілка активна
    });
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
    exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 41.5, amountBase: paidBase });
    const pr = prisma as never as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
    pr.settlementTransaction.aggregate.mockResolvedValue({ _sum: { amountBase: chargeBase } });
    pr.settlementTransaction.count.mockResolvedValue(existingFx);
    pr.payment.aggregate.mockResolvedValue({ _sum: { amountBase: paidBase } });
  };

  // Дістає FX-виклик createTransaction (тип FX_GAIN/FX_LOSS), якщо був.
  const fxCall = () =>
    settlements.createTransaction.mock.calls.find(
      c => c[1]?.type === 'FX_GAIN' || c[1]?.type === 'FX_LOSS',
    );

  it('повна оплата USD-інвойсу, chargeBase>paidBase → FX_LOSS на різницю (base), documentId=інвойс', async () => {
    // Нараховано 4200 base (курс документа), отримано 4150 base (курс оплати) → збиток 50.
    setupFxInvoicePaid(4200, 4150);
    await service.create(ORG, { ...usdCashDto, invoiceId: INV_FX }, 'user-1');
    const call = fxCall();
    expect(call).toBeDefined();
    expect(call![0]).toBe(ORG);
    expect(call![1]).toMatchObject({
      type: 'FX_LOSS',
      amount: 50,
      documentType: 'Invoice',
      documentId: INV_FX,
    });
    // FX-проводка БЕЗ currencyId → base-дельта (rate=1).
    expect(call![1].currencyId).toBeUndefined();
  });

  it('повна оплата USD-інвойсу, paidBase>chargeBase → FX_GAIN на різницю', async () => {
    // Нараховано 4100 base, отримано 4150 base → прибуток 50.
    setupFxInvoicePaid(4100, 4150);
    await service.create(ORG, { ...usdCashDto, invoiceId: INV_FX }, 'user-1');
    const call = fxCall();
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({ type: 'FX_GAIN', amount: 50, documentId: INV_FX });
  });

  it('fx ≈ 0 (той самий курс, chargeBase==paidBase) → FX НЕ бронюється', async () => {
    setupFxInvoicePaid(4150, 4150);
    await service.create(ORG, { ...usdCashDto, invoiceId: INV_FX }, 'user-1');
    expect(fxCall()).toBeUndefined();
  });

  it('idempotency: FX для рахунку вже проведено (count>0) → повторно НЕ бронюється', async () => {
    setupFxInvoicePaid(4200, 4150, 1); // existingFx=1
    await service.create(ORG, { ...usdCashDto, invoiceId: INV_FX }, 'user-1');
    expect(fxCall()).toBeUndefined();
  });

  it('часткова оплата (PARTIALLY_PAID) → FX НЕ бронюється (лише при повній)', async () => {
    prisma.cashRegister.findFirst.mockResolvedValue({
      id: CASH_ID,
      isFiscal: false,
      currencyId: USD_ID,
    });
    prisma.invoice.findFirst.mockResolvedValue({
      counterpartyId: CP_ID,
      id: INV_FX,
      status: 'SENT',
      workOrderId: null,
      amount: 200, // оплата 100 < 200 → PARTIALLY_PAID
      paidAmount: 0,
      currencyId: USD_ID,
    });
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
    exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 41.5, amountBase: 4150 });
    await service.create(ORG, { ...usdCashDto, invoiceId: INV_FX }, 'user-1');
    expect(fxCall()).toBeUndefined();
  });

  it('base-валютний інвойс повністю сплачено → FX НЕ бронюється (немає курсової різниці)', async () => {
    prisma.cashRegister.findFirst.mockResolvedValue({
      id: CASH_ID,
      isFiscal: false,
      currencyId: UAH_ID,
    });
    prisma.invoice.findFirst.mockResolvedValue({
      counterpartyId: CP_ID,
      id: INV_FX,
      status: 'SENT',
      workOrderId: null,
      amount: 100,
      paidAmount: 0,
      currencyId: UAH_ID, // == base → FX-гілка неактивна
    });
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
    exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 1, amountBase: 100 });
    await service.create(ORG, { ...usdCashDto, invoiceId: INV_FX }, 'user-1');
    expect(fxCall()).toBeUndefined();
  });

  it('WO-linked USD-інвойс: chargeBase береться з WorkOrder-CHARGE (леджер), documentType=Invoice у FX', async () => {
    const WO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    prisma.cashRegister.findFirst.mockResolvedValue({
      id: CASH_ID,
      isFiscal: false,
      currencyId: USD_ID,
    });
    prisma.workOrder.findFirst.mockResolvedValue({
      branchId: 'br-1',
      status: 'INVOICED',
      currencyId: USD_ID,
    });
    prisma.workOrder.update.mockResolvedValue({});
    prisma.invoice.findFirst.mockResolvedValue({
      counterpartyId: CP_ID,
      id: INV_FX,
      status: 'SENT',
      workOrderId: WO, // WO-linked → chargeDoc = WorkOrder
      amount: 100,
      paidAmount: 0,
      currencyId: USD_ID,
    });
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
    exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 41.5, amountBase: 4150 });
    const pr = prisma as never as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
    pr.settlementTransaction.aggregate.mockResolvedValue({ _sum: { amountBase: 4200 } }); // WO CHARGE base
    pr.settlementTransaction.count.mockResolvedValue(0);
    pr.payment.aggregate.mockResolvedValue({ _sum: { amountBase: 4150 } });

    await service.create(ORG, { ...usdCashDto, invoiceId: INV_FX, workOrderId: WO }, 'user-1');

    // chargeBase-агрегат шукав CHARGE проти WorkOrder (не Invoice).
    expect(pr.settlementTransaction.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: 'CHARGE',
          documentType: 'WorkOrder',
          documentId: WO,
        }),
      }),
    );
    // FX-проводка йде під documentType=Invoice (idempotency-ключ), сума 4200−4150=50 → LOSS.
    expect(fxCall()![1]).toMatchObject({
      type: 'FX_LOSS',
      amount: 50,
      documentType: 'Invoice',
      documentId: INV_FX,
    });
  });
});
