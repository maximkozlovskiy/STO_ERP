/**
 * PaymentsService — FIN-C1: ідемпотентність оплати рахунку (CAS SENT→PAID)
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

/**
 * FIN-C1: ідемпотентність оплати рахунку. Перехід SENT→PAID виконується ПЕРШИМ у tx через
 * compare-and-swap (updateMany where status:'SENT'). Два concurrent create бачать SENT на
 * stale-read, але лише ОДИН updateMany змінить count=1 — другий отримає count=0 → throw →
 * rollback (без другого Payment/PAYMENT-settlement/чека). Ці спеки — regression guard для
 * CRITICAL грошового фіксу (раніше без тестів).
 */
describe('PaymentsService — FIN-C1 ідемпотентність оплати', () => {
  let service: PaymentsService;
  let prisma: {
    counterparty: { findFirst: ReturnType<typeof vi.fn> };
    workOrder: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    invoice: { findFirst: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
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

  beforeEach(async () => {
    prisma = {
      counterparty: { findFirst: vi.fn() },
      workOrder: { findFirst: vi.fn(), update: vi.fn() },
      invoice: { findFirst: vi.fn(), updateMany: vi.fn() },
      payment: { create: vi.fn() },
      // За замовч. метод потребує фіскалізації → checkbox-enqueue фірес як раніше.
      paymentMethodConfig: { findFirst: vi.fn().mockResolvedValue({ requiresFiscal: true }) },
      bankAccount: { findFirst: vi.fn() },
      cashRegister: { findFirst: vi.fn() },
      // Виконує callback з prisma як tx — CAS updateMany/payment.create реально викликаються.
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
        {
          provide: NotificationsService,
          useValue: { send: vi.fn().mockResolvedValue(undefined) },
        },
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

  const baseDto = {
    counterpartyId: CP_ID,
    invoiceId: INV_ID,
    amount: 500,
    method: 'CASH',
  };

  // guards: BR-PAY-003
  it('CAS count=0 (paidAmount змінено паралельно) → throw, БЕЗ payment.create та settlement', async () => {
    prisma.counterparty.findFirst.mockResolvedValue({
      id: CP_ID,
      phone: null,
      firstName: null,
      lastName: null,
      companyName: 'ТОВ',
    });
    // amount 500 / paidAmount 0 → повна оплата 500; але CAS програє гонку (count=0).
    prisma.invoice.findFirst.mockResolvedValue({
      status: 'SENT',
      workOrderId: null,
      amount: 500,
      paidAmount: 0,
    });
    prisma.invoice.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.create(ORG, baseDto, 'user-1')).rejects.toThrow(BadRequestException);
    // CAS спрацював, але не виграв гонку → жодних грошових side-effects.
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(settlements.createTransaction).not.toHaveBeenCalled();
    expect(checkboxQueue.add).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-003, BR-PAY-004
  it('happy-path: CAS(paidAmount) count=1 → paidAmount+=amount, status→PAID ПЕРЕД create + settlement', async () => {
    prisma.counterparty.findFirst.mockResolvedValue({
      id: CP_ID,
      phone: null,
      firstName: null,
      lastName: null,
      companyName: 'ТОВ',
    });
    prisma.invoice.findFirst.mockResolvedValue({
      status: 'SENT',
      workOrderId: null,
      amount: 500,
      paidAmount: 0,
    });
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
    prisma.payment.create.mockResolvedValue(createdPayment);

    await service.create(ORG, baseDto, 'user-1');

    // CAS по paidAmount (не по status): where містить прочитаний paidAmount; повна оплата → PAID.
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: INV_ID, orgId: ORG, paidAmount: 0 }),
        data: expect.objectContaining({ paidAmount: 500, status: 'PAID' }),
      }),
    );
    const casOrder = prisma.invoice.updateMany.mock.invocationCallOrder[0];
    const createOrder = prisma.payment.create.mock.invocationCallOrder[0];
    expect(casOrder).toBeLessThan(createOrder);
    expect(settlements.createTransaction).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ type: 'PAYMENT', amount: 500, documentType: 'Payment' }),
      expect.anything(),
    );
  });

  // guards: BR-PAY-003
  it('часткова оплата: 200 з 500 → paidAmount=200, status=PARTIALLY_PAID', async () => {
    prisma.counterparty.findFirst.mockResolvedValue({
      id: CP_ID,
      phone: null,
      firstName: null,
      lastName: null,
      companyName: 'ТОВ',
    });
    prisma.invoice.findFirst.mockResolvedValue({
      status: 'SENT',
      workOrderId: null,
      amount: 500,
      paidAmount: 0,
    });
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
    prisma.payment.create.mockResolvedValue(createdPayment);

    await service.create(ORG, { ...baseDto, amount: 200 }, 'user-1');

    expect(prisma.invoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paidAmount: 200, status: 'PARTIALLY_PAID' }),
      }),
    );
  });

  // guards: BR-PAY-003
  it('переплата: сума > залишку → throw ПЕРЕД CAS (без updateMany/create)', async () => {
    prisma.counterparty.findFirst.mockResolvedValue({
      id: CP_ID,
      phone: null,
      firstName: null,
      lastName: null,
      companyName: 'ТОВ',
    });
    // залишок = 500−400 = 100; платіж 500 → переплата.
    prisma.invoice.findFirst.mockResolvedValue({
      status: 'PARTIALLY_PAID',
      workOrderId: null,
      amount: 500,
      paidAmount: 400,
    });

    await expect(service.create(ORG, baseDto, 'user-1')).rejects.toThrow(/перевищує залишок/);
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(settlements.createTransaction).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-003
  it('рахунок у DRAFT → throw ПЕРЕД CAS (лише SENT/PARTIALLY_PAID приймають оплату)', async () => {
    prisma.counterparty.findFirst.mockResolvedValue({
      id: CP_ID,
      phone: null,
      firstName: null,
      lastName: null,
      companyName: 'ТОВ',
    });
    prisma.invoice.findFirst.mockResolvedValue({
      status: 'DRAFT',
      workOrderId: null,
      amount: 500,
      paidAmount: 0,
    });

    await expect(service.create(ORG, baseDto, 'user-1')).rejects.toThrow(BadRequestException);
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(settlements.createTransaction).not.toHaveBeenCalled();
  });

  // ── resolveDestinationAccount: явний ввід (строго) vs config-дефолт (best-effort) ──
  const BANK_ID = '55555555-5555-4555-8555-555555555555';

  // guards: BR-PAY-002
  it('явний sourceType=BANK_ACCOUNT з DTO + невалідний/чужий рахунок → NotFound (строга валідація вводу)', async () => {
    prisma.counterparty.findFirst.mockResolvedValue({
      id: CP_ID,
      phone: null,
      firstName: null,
      lastName: null,
      companyName: 'ТОВ',
    });
    prisma.bankAccount.findFirst.mockResolvedValue(null); // не існує / крос-tenant / soft-deleted

    await expect(
      service.create(
        ORG,
        { ...baseDto, sourceType: 'BANK_ACCOUNT', bankAccountId: BANK_ID },
        'user-1',
      ),
    ).rejects.toThrow(/Банківський рахунок не знайдено/);
    // Ввід невалідний → платіж НЕ створюється.
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-002
  it('config-дефолт BANK_ACCOUNT з видаленим рахунком (stale) → degrade to null, платіж УСПІШНИЙ (offline-first)', async () => {
    prisma.counterparty.findFirst.mockResolvedValue({
      id: CP_ID,
      phone: null,
      firstName: null,
      lastName: null,
      companyName: 'ТОВ',
    });
    // methodConfig дає дефолтний банк-рахунок, але його з тих пір soft-delete-нули.
    prisma.paymentMethodConfig.findFirst.mockResolvedValue({
      requiresFiscal: false,
      defaultSourceType: 'BANK_ACCOUNT',
      defaultBankAccountId: BANK_ID,
      defaultCashRegisterId: null,
    });
    prisma.bankAccount.findFirst.mockResolvedValue(null); // stale default
    prisma.invoice.findFirst.mockResolvedValue({
      status: 'SENT',
      workOrderId: null,
      amount: 500,
      paidAmount: 0,
    });
    prisma.invoice.updateMany.mockResolvedValue({ count: 1 });
    prisma.payment.create.mockResolvedValue(createdPayment);

    // НЕ кидає: застарілий конфіг не має валити легітимний рух грошей.
    await service.create(ORG, baseDto, 'user-1');

    // Source-link знято (null), але платіж + settlement створені.
    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceType: null,
          bankAccountId: null,
          cashRegisterId: null,
        }),
      }),
    );
    expect(settlements.createTransaction).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ type: 'PAYMENT', amount: 500 }),
      expect.anything(),
    );
  });
});

/**
 * Bug #661 / #662 — regression guard для requiresFiscal-гейта у PaymentsService.create
 * (feat(prro): Checkbox ПРРО Крок 1, commit 247cfaec + review-fix).
 *
 * Гейт — load-bearing логіка: платіж фіскалізується ЛИШЕ якщо PaymentMethodConfig.requiresFiscal
 * === true. Три гілки МАЮТЬ бути покриті (mutation-verify: без гейта чек ставився б на кожен
 * платіж — готівка/безнал/бартер — зайві job-и + помилкові чеки у Checkbox):
 *   - requiresFiscal=true  → checkboxQueue.add викликано + payment.fiscalStatus='QUEUED'
 *   - requiresFiscal=false → add НЕ викликано + fiscalStatus=null
 *   - unknown method (methodConfig=null) → add НЕ викликано + fiscalStatus=null
 *
 * Bug #662: review-fix .catch() навколо checkboxQueue.add. Якщо Redis лежить і add() reject-ить,
 * create() ВСЕ ОДНО повертає (фінансова операція вже закомічена — offline-first CLAUDE.md §3), а
 * платіж переводиться QUEUED→FAILED (не завис навічно у QUEUED без жодного job-а).
 */
