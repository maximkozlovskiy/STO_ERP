/**
 * PaymentsService — money-model Phase 1: gap-filling
 *
 * Виділено з `payments.service.spec.ts` (був 1720 рядків, 5 незалежних top-level
 * describe) 2026-10-06. Кейси перенесені ДОСЛІВНО, назви describe не змінені —
 * інакше `fullName` у test-baseline.json розійшовся б.
 *
 * `exchangeRatesMock()` — з `./payments.spec-fixture` (був у преамбулі, 4 вживання).
 */

import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
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
import { exchangeRatesMock } from './payments.spec-fixture';

describe('PaymentsService — money-model Phase 1 gap-filling (Bugs #668-#674)', () => {
  let service: PaymentsService;
  let prisma: {
    counterparty: { findFirst: ReturnType<typeof vi.fn> };
    workOrder: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    invoice: { findFirst: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    garageBranch: { findFirst: ReturnType<typeof vi.fn> };
    payment: { create: ReturnType<typeof vi.fn> };
    paymentMethodConfig: { findFirst: ReturnType<typeof vi.fn> };
    bankAccount: { findFirst: ReturnType<typeof vi.fn> };
    cashRegister: { findFirst: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let settlements: { createTransaction: ReturnType<typeof vi.fn> };
  let checkboxQueue: { add: ReturnType<typeof vi.fn> };

  const ORG = 'org-1';
  const CP_ID = '22222222-2222-4222-8222-222222222222';
  const INV_ID = '33333333-3333-4333-8333-333333333333';
  const PAY_ID = '44444444-4444-4444-8444-444444444444';
  const BANK_ID = '55555555-5555-4555-8555-555555555555';
  const CASH_ID = '66666666-6666-4666-8666-666666666666';

  let lastCreateData: Record<string, unknown> | undefined;

  const createdPayment = {
    id: PAY_ID,
    orgId: ORG,
    counterpartyId: CP_ID,
    workOrderId: null,
    invoiceId: INV_ID,
    amount: 500,
    method: 'CASH',
    notes: null,
    fiscalReceiptId: null,
    createdAt: new Date(),
    counterparty: { firstName: null, lastName: null, companyName: 'ТОВ' },
  };

  const cp = {
    id: CP_ID,
    phone: null,
    email: null,
    firstName: null,
    lastName: null,
    companyName: 'ТОВ',
  };

  beforeEach(async () => {
    lastCreateData = undefined;
    prisma = {
      counterparty: { findFirst: vi.fn().mockResolvedValue(cp) },
      workOrder: { findFirst: vi.fn(), update: vi.fn() },
      invoice: { findFirst: vi.fn(), updateMany: vi.fn() },
      garageBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'br-1' }) },
      payment: {
        create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          lastCreateData = args.data;
          return Promise.resolve(createdPayment);
        }),
      },
      // За замовч. метод БЕЗ фіскалізації → checkbox не заважає перевіркам джерела/оплати.
      paymentMethodConfig: { findFirst: vi.fn().mockResolvedValue({ requiresFiscal: false }) },
      bankAccount: { findFirst: vi.fn() },
      cashRegister: { findFirst: vi.fn() },
      $transaction: vi.fn().mockImplementation(async (arg: unknown) => {
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return undefined;
      }),
    };
    settlements = { createTransaction: vi.fn() };
    checkboxQueue = { add: vi.fn().mockResolvedValue(undefined) };

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
        { provide: LoyaltyService, useValue: { queueEarn: vi.fn().mockResolvedValue(undefined) } },
        // C1: аудит best-effort — мок record() (no-op).
        { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        {
          provide: CashService,
          useValue: { createOperation: vi.fn().mockResolvedValue(undefined) },
        },
        { provide: ExchangeRatesService, useValue: exchangeRatesMock() },
        { provide: getQueueToken('checkbox'), useValue: checkboxQueue },
      ],
    }).compile();
    service = module.get(PaymentsService);
  });

  const baseDto = { counterpartyId: CP_ID, invoiceId: INV_ID, amount: 500, method: 'CASH' };

  // ── Часткова→повна послідовність + рівно-залишок ──────────────────────────

  // guards: BR-PAY-003
  it('Bug #668: оплата залишку з PARTIALLY_PAID-бази (300 при paid=200/500) → paidAmount=500, PAID', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      status: 'PARTIALLY_PAID',
      workOrderId: null,
      amount: 500,
      paidAmount: 200,
    });
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

    await service.create(ORG, { ...baseDto, amount: 300 }, 'user-1');

    // newPaid = 200 + 300 = 500 == amount → PAID; CAS where несе прочитаний paidAmount=200.
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: INV_ID, orgId: ORG, paidAmount: 200 }),
        data: expect.objectContaining({ paidAmount: 500, status: 'PAID' }),
      }),
    );
  });

  // guards: BR-PAY-003
  it('Bug #669: оплата РІВНО залишку (100 при paid=400/500) → PAID, не PARTIALLY_PAID', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      status: 'PARTIALLY_PAID',
      workOrderId: null,
      amount: 500,
      paidAmount: 400,
    });
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

    await service.create(ORG, { ...baseDto, amount: 100 }, 'user-1');

    expect(prisma.invoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paidAmount: 500, status: 'PAID' }),
      }),
    );
  });

  // guards: BR-PAY-003
  it('Bug #670: переплата з PARTIALLY_PAID-бази (300 при залишку 200) → throw ПЕРЕД CAS/create', async () => {
    // amount 500, paid 300 → remaining 200; платіж 300 > 200.
    prisma.invoice.findFirst.mockResolvedValue({
      status: 'PARTIALLY_PAID',
      workOrderId: null,
      amount: 500,
      paidAmount: 300,
    });

    await expect(service.create(ORG, { ...baseDto, amount: 300 }, 'user-1')).rejects.toThrow(
      /перевищує залишок/,
    );
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(settlements.createTransaction).not.toHaveBeenCalled();
  });

  // ── Concurrency: два платежі, обидва читають paidAmount=0 ─────────────────

  // guards: BR-PAY-003
  it('Bug #671: два послідовних платежі (count=1, потім count=0) → другий throw, БЕЗ Payment/settlement', async () => {
    // Обидва читають paidAmount=0 (stale). Перший CAS виграє (count=1), другий програє (count=0).
    prisma.invoice.findFirst.mockResolvedValue({
      status: 'SENT',
      workOrderId: null,
      amount: 500,
      paidAmount: 0,
    });
    prisma.invoice.updateMany
      .mockResolvedValueOnce({ count: 1 }) // 1-й платіж виграв гонку
      .mockResolvedValueOnce({ count: 0 }); // 2-й — paidAmount вже змінено

    // Перший — успіх.
    await service.create(ORG, { ...baseDto, amount: 300 }, 'user-1');
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    expect(settlements.createTransaction).toHaveBeenCalledTimes(1);

    // Другий — CAS програє → throw, жодного нового Payment/settlement (no double-charge).
    await expect(service.create(ORG, { ...baseDto, amount: 300 }, 'user-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.payment.create).toHaveBeenCalledTimes(1); // без інкременту
    expect(settlements.createTransaction).toHaveBeenCalledTimes(1); // без інкременту
  });

  // ── status-gate: PAID / CANCELLED (не лише DRAFT) ─────────────────────────

  // guards: BR-PAY-003
  it('Bug #672: рахунок у PAID → throw (лише SENT/PARTIALLY_PAID приймають оплату)', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      status: 'PAID',
      workOrderId: null,
      amount: 500,
      paidAmount: 500,
    });
    await expect(service.create(ORG, baseDto, 'user-1')).rejects.toThrow(BadRequestException);
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(settlements.createTransaction).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-003
  it('Bug #672: рахунок у CANCELLED → throw', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      status: 'CANCELLED',
      workOrderId: null,
      amount: 500,
      paidAmount: 0,
    });
    await expect(service.create(ORG, baseDto, 'user-1')).rejects.toThrow(BadRequestException);
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  // OVERDUE — третій оплачуваний статус: прострочений рахунок усе ще належить сплатити.
  // guards: BR-PAY-003
  it('рахунок у OVERDUE → оплата приймається: часткова → PARTIALLY_PAID, повна → PAID', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      status: 'OVERDUE',
      workOrderId: null,
      amount: 500,
      paidAmount: 0,
    });
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

    await service.create(ORG, { ...baseDto, amount: 200 }, 'user-1');
    await service.create(ORG, { ...baseDto, amount: 500 }, 'user-1');

    expect(prisma.invoice.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({ paidAmount: 200, status: 'PARTIALLY_PAID' }),
      }),
    );
    expect(prisma.invoice.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ paidAmount: 500, status: 'PAID' }),
      }),
    );
    expect(prisma.payment.create).toHaveBeenCalledTimes(2);
    expect(settlements.createTransaction).toHaveBeenCalledTimes(2);
  });

  // ── resolveDestinationAccount: CASH_REGISTER + explicit-strict варіанти ────

  it('Bug #673: explicit CASH_REGISTER + валідна каса → stored у payment.create', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      status: 'SENT',
      workOrderId: null,
      amount: 500,
      paidAmount: 0,
    });
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
    prisma.cashRegister.findFirst.mockResolvedValue({ id: CASH_ID });

    await service.create(
      ORG,
      { ...baseDto, sourceType: 'CASH_REGISTER', cashRegisterId: CASH_ID },
      'user-1',
    );

    expect(prisma.cashRegister.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: CASH_ID, orgId: ORG, deletedAt: null }),
      }),
    );
    expect(lastCreateData?.sourceType).toBe('CASH_REGISTER');
    expect(lastCreateData?.cashRegisterId).toBe(CASH_ID);
    expect(lastCreateData?.bankAccountId).toBeNull();
  });

  // guards: BR-PAY-002
  it('Bug #673: explicit CASH_REGISTER + чужа/видалена каса → NotFound (строга валідація), без Payment', async () => {
    prisma.cashRegister.findFirst.mockResolvedValue(null);
    await expect(
      service.create(
        ORG,
        { ...baseDto, sourceType: 'CASH_REGISTER', cashRegisterId: CASH_ID },
        'user-1',
      ),
    ).rejects.toThrow(/Касу не знайдено/);
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('Bug #673: explicit BANK_ACCOUNT + валідний рахунок → stored', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      status: 'SENT',
      workOrderId: null,
      amount: 500,
      paidAmount: 0,
    });
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
    prisma.bankAccount.findFirst.mockResolvedValue({ id: BANK_ID });

    await service.create(
      ORG,
      { ...baseDto, sourceType: 'BANK_ACCOUNT', bankAccountId: BANK_ID },
      'user-1',
    );

    expect(lastCreateData?.sourceType).toBe('BANK_ACCOUNT');
    expect(lastCreateData?.bankAccountId).toBe(BANK_ID);
    expect(lastCreateData?.cashRegisterId).toBeNull();
  });

  // guards: BR-PAY-002
  it('Bug #674: explicit sourceType=BANK_ACCOUNT БЕЗ bankAccountId → 400, без Payment', async () => {
    await expect(
      service.create(ORG, { ...baseDto, sourceType: 'BANK_ACCOUNT' }, 'user-1'),
    ).rejects.toThrow(/Не вказано банківський рахунок/);
    expect(prisma.payment.create).not.toHaveBeenCalled();
    // Валідація вводу ДО будь-якого запиту рахунку.
    expect(prisma.bankAccount.findFirst).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-002
  it('Bug #674: explicit sourceType=CASH_REGISTER БЕЗ cashRegisterId → 400, без Payment', async () => {
    await expect(
      service.create(ORG, { ...baseDto, sourceType: 'CASH_REGISTER' }, 'user-1'),
    ).rejects.toThrow(/Не вказано касу/);
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.cashRegister.findFirst).not.toHaveBeenCalled();
  });

  it('Bug #674: methodConfig=null (невідомий метод) → джерело null, платіж успішний', async () => {
    prisma.paymentMethodConfig.findFirst.mockResolvedValue(null);
    prisma.invoice.findFirst.mockResolvedValue({
      status: 'SENT',
      workOrderId: null,
      amount: 500,
      paidAmount: 0,
    });
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

    await service.create(ORG, baseDto, 'user-1');

    expect(lastCreateData?.sourceType).toBeNull();
    expect(lastCreateData?.bankAccountId).toBeNull();
    expect(lastCreateData?.cashRegisterId).toBeNull();
    // Невідомий метод не блокує рух грошей.
    expect(prisma.payment.create).toHaveBeenCalledTimes(1);
  });

  // ── Кожна часткова оплата → рівно один PAYMENT-settlement своєї суми ──────

  // guards: BR-PAY-004
  it('Bug #668: часткова оплата 200 → рівно 1 PAYMENT-settlement на 200 (борг зменшується на суму)', async () => {
    prisma.invoice.findFirst.mockResolvedValue({
      status: 'SENT',
      workOrderId: null,
      amount: 500,
      paidAmount: 0,
    });
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });

    await service.create(ORG, { ...baseDto, amount: 200 }, 'user-1');

    expect(settlements.createTransaction).toHaveBeenCalledTimes(1);
    expect(settlements.createTransaction).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ type: 'PAYMENT', amount: 200, documentType: 'Payment' }),
      expect.anything(),
    );
  });
});

/**
 * Session 2026-09-06 — payments Phase 2 (сторінка /payments) — findAll/findOne/retryFiscal/toDto.
 * Регресія-guard для review-fix 9710c556 (dateTo inclusive-of-day + fiscalStatus enum-guard).
 *
 * Ці методи (findAll/findOne/retryFiscal) до цієї сесії мали 0 unit-тестів — увесь spec вище
 * покривав лише create(). Load-bearing логіка ревʼю-фіксу:
 *   1. findAll date-range INCLUSIVITY: платіж о 2026-09-06T15:00 МУСИТЬ повертатись при
 *      dateTo='2026-09-06' → where.createdAt.lte = '2026-09-06T23:59:59.999Z' (не midnight).
 *   2. fiscalStatus: enum → eq; 'none' → IS NULL; garbage → фільтр НЕ застосовано (no 500).
 *   3. retryFiscal guards: fiscalReceiptId → 400; !=FAILED → 400; FAILED → QUEUED + enqueue;
 *      queue reject → .catch FAILED (no 500); tenant-scoped (cross-org → NotFound).
 *   4. toDto sourceName: bank name → cash name → null.
 */
