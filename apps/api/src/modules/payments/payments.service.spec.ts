import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SettlementsService } from '../settlements/settlements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WorkOrdersService } from '../work-orders/work-orders.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { AuditService } from '../audit/audit.service';

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
describe('PaymentsService — Bug #661/#662 requiresFiscal-гейт + enqueue .catch()', () => {
  let service: PaymentsService;
  let prisma: {
    counterparty: { findFirst: ReturnType<typeof vi.fn> };
    workOrder: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    invoice: { findFirst: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    garageBranch: { findFirst: ReturnType<typeof vi.fn> };
    payment: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    paymentMethodConfig: { findFirst: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let settlements: { createTransaction: ReturnType<typeof vi.fn> };
  let checkboxQueue: { add: ReturnType<typeof vi.fn> };
  let loyalty: { queueEarn: ReturnType<typeof vi.fn> };

  const ORG = 'org-1';
  const CP_ID = '22222222-2222-4222-8222-222222222222';
  const PAY_ID = '44444444-4444-4444-8444-444444444444';

  // Захоплюємо data, з яким викликано payment.create — щоб перевірити fiscalStatus.
  let lastCreateData: Record<string, unknown> | undefined;

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
            amount: 500,
            method: (args.data.method as string) ?? 'CASH',
            notes: null,
            fiscalReceiptId: null,
            fiscalStatus: args.data.fiscalStatus ?? null,
            fiscalError: null,
            createdAt: new Date(),
            counterparty: { firstName: null, lastName: null, companyName: 'ТОВ' },
          });
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      paymentMethodConfig: { findFirst: vi.fn() },
      $transaction: vi.fn().mockImplementation(async (arg: unknown) => {
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return undefined;
      }),
    };
    settlements = { createTransaction: vi.fn() };
    checkboxQueue = { add: vi.fn().mockResolvedValue(undefined) };
    loyalty = { queueEarn: vi.fn().mockResolvedValue(undefined) };

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
        { provide: getQueueToken('checkbox'), useValue: checkboxQueue },
      ],
    }).compile();
    service = module.get(PaymentsService);
  });

  const dto = { counterpartyId: CP_ID, amount: 500, method: 'card' };

  it('requiresFiscal=true → checkboxQueue.add викликано + fiscalStatus="QUEUED"', async () => {
    prisma.paymentMethodConfig.findFirst.mockResolvedValue({ requiresFiscal: true });

    await service.create(ORG, dto, 'user-1');

    expect(checkboxQueue.add).toHaveBeenCalledTimes(1);
    expect(checkboxQueue.add).toHaveBeenCalledWith(
      'fiscal-receipt',
      expect.objectContaining({ paymentId: PAY_ID, orgId: ORG, method: 'card' }),
      expect.objectContaining({ attempts: 288, removeOnFail: 200 }),
    );
    // Гейт пише QUEUED у payment.create.data
    expect(lastCreateData?.fiscalStatus).toBe('QUEUED');
  });

  it('requiresFiscal=false → add НЕ викликано + fiscalStatus=null', async () => {
    prisma.paymentMethodConfig.findFirst.mockResolvedValue({ requiresFiscal: false });

    await service.create(ORG, dto, 'user-1');

    expect(checkboxQueue.add).not.toHaveBeenCalled();
    expect(lastCreateData?.fiscalStatus).toBeNull();
  });

  it('невідомий метод (methodConfig=null) → add НЕ викликано + fiscalStatus=null (safe default)', async () => {
    prisma.paymentMethodConfig.findFirst.mockResolvedValue(null);

    await service.create(ORG, dto, 'user-1');

    expect(checkboxQueue.add).not.toHaveBeenCalled();
    expect(lastCreateData?.fiscalStatus).toBeNull();
  });

  it('Bug #662: checkboxQueue.add reject (Redis лежить) → create() НЕ кидає (no 500) + payment QUEUED→FAILED', async () => {
    prisma.paymentMethodConfig.findFirst.mockResolvedValue({ requiresFiscal: true });
    checkboxQueue.add.mockRejectedValue(new Error('Redis connection refused'));

    // create НЕ кидає — фінансова операція вже успішна (offline-first).
    const result = await service.create(ORG, dto, 'user-1');
    expect(result.id).toBe(PAY_ID);

    // Платіж переведено QUEUED→FAILED, щоб не завис навічно у QUEUED.
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PAY_ID, orgId: ORG },
        data: expect.objectContaining({ fiscalStatus: 'FAILED' }),
      }),
    );
  });

  it('Bug #662: navіть якщо payment.update (FAILED-запис) теж кине — create() все одно не валиться', async () => {
    prisma.paymentMethodConfig.findFirst.mockResolvedValue({ requiresFiscal: true });
    checkboxQueue.add.mockRejectedValue(new Error('Redis down'));
    prisma.payment.update.mockRejectedValue(new Error('DB flaked'));

    await expect(service.create(ORG, dto, 'user-1')).resolves.toMatchObject({ id: PAY_ID });
  });
});

/**
 * Session 2026-09-06 — money-model Phase 1 gap-filling (Bugs #668-#674).
 *
 * Прогалини у coverage FIN-C1 часткової оплати, виявлені сесією sto-tester:
 *  - послідовність часткова→повна (PARTIALLY_PAID → PAID) з невід'ємним залишком;
 *  - оплата РІВНО залишку з PARTIALLY_PAID-бази → PAID;
 *  - переплата коли remaining=залишок після часткової (300 при залишку 200);
 *  - concurrency-модель двох платежів через послідовність count=1 → count=0;
 *  - status-gate PAID / CANCELLED (не лише DRAFT);
 *  - resolveDestinationAccount: CASH_REGISTER-шлях, explicit BANK valid→stored,
 *    explicit sourceType БЕЗ id → 400, methodConfig=null → null-джерело;
 *  - кожна часткова оплата → рівно один PAYMENT-settlement своєї суми.
 */
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
        { provide: getQueueToken('checkbox'), useValue: checkboxQueue },
      ],
    }).compile();
    service = module.get(PaymentsService);
  });

  const baseDto = { counterpartyId: CP_ID, invoiceId: INV_ID, amount: 500, method: 'CASH' };

  // ── Часткова→повна послідовність + рівно-залишок ──────────────────────────

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

  it('Bug #674: explicit sourceType=BANK_ACCOUNT БЕЗ bankAccountId → 400, без Payment', async () => {
    await expect(
      service.create(ORG, { ...baseDto, sourceType: 'BANK_ACCOUNT' }, 'user-1'),
    ).rejects.toThrow(/Не вказано банківський рахунок/);
    expect(prisma.payment.create).not.toHaveBeenCalled();
    // Валідація вводу ДО будь-якого запиту рахунку.
    expect(prisma.bankAccount.findFirst).not.toHaveBeenCalled();
  });

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
describe('PaymentsService — Phase 2 findAll/findOne/retryFiscal/toDto', () => {
  let service: PaymentsService;
  let prisma: {
    counterparty: { findFirst: ReturnType<typeof vi.fn> };
    workOrder: { findFirst: ReturnType<typeof vi.fn> };
    garageBranch: { findFirst: ReturnType<typeof vi.fn> };
    payment: {
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
  let checkboxQueue: { add: ReturnType<typeof vi.fn> };

  const ORG = 'org-1';
  const CP_ID = '22222222-2222-4222-8222-222222222222';
  const PAY_ID = '44444444-4444-4444-8444-444444444444';

  // Мінімальний payment-рядок (як його повертає Prisma з PAYMENT_INCLUDE).
  const paymentRow = (over: Record<string, unknown> = {}) => ({
    id: PAY_ID,
    orgId: ORG,
    counterpartyId: CP_ID,
    workOrderId: null,
    invoiceId: null,
    amount: 500,
    method: 'card',
    notes: null,
    fiscalReceiptId: null,
    fiscalStatus: null,
    fiscalError: null,
    sourceType: null,
    bankAccountId: null,
    cashRegisterId: null,
    bankAccount: null,
    cashRegister: null,
    createdAt: new Date('2026-09-06T15:00:00.000Z'),
    counterparty: { firstName: 'Іван', lastName: 'Петренко', companyName: null },
    ...over,
  });

  beforeEach(async () => {
    prisma = {
      counterparty: { findFirst: vi.fn() },
      workOrder: { findFirst: vi.fn() },
      garageBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'br-1' }) },
      payment: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    checkboxQueue = { add: vi.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SettlementsService, useValue: { createTransaction: vi.fn() } },
        { provide: NotificationsService, useValue: { send: vi.fn().mockResolvedValue(undefined) } },
        {
          provide: WorkOrdersService,
          useValue: { transition: vi.fn().mockResolvedValue(undefined) },
        },
        { provide: LoyaltyService, useValue: { queueEarn: vi.fn().mockResolvedValue(undefined) } },
        // C1: аудит best-effort — мок record() (no-op).
        { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        { provide: getQueueToken('checkbox'), useValue: checkboxQueue },
      ],
    }).compile();
    service = module.get(PaymentsService);
  });

  // Дістає where, з яким викликано findMany (щоб асертити межі createdAt/фільтри).
  const lastWhere = () =>
    (prisma.payment.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;

  // ── 1. Date-range INCLUSIVITY (review-fix 9710c556) ───────────────────────

  it('dateTo → where.createdAt.lte = кінець доби 23:59:59.999Z (inclusive-of-full-day)', async () => {
    await service.findAll(ORG, { dateTo: '2026-09-06' });
    const createdAt = lastWhere().createdAt as { lte?: Date };
    // МУТАЦІЯ-guard: якщо відкотити на `new Date(dateTo)` (midnight), lte був би
    // 2026-09-06T00:00:00Z і платіж о 15:00 випав би. Перевіряємо саме кінець доби.
    expect(createdAt.lte).toBeInstanceOf(Date);
    expect((createdAt.lte as Date).toISOString()).toBe('2026-09-06T23:59:59.999Z');
    // Платіж о 15:00 того ж дня МУСИТЬ проходити межу.
    const paidAt = new Date('2026-09-06T15:00:00.000Z');
    expect(paidAt.getTime()).toBeLessThanOrEqual((createdAt.lte as Date).getTime());
  });

  it('dateFrom → where.createdAt.gte = початок доби 00:00:00.000Z (нижня межа)', async () => {
    await service.findAll(ORG, { dateFrom: '2026-09-06' });
    const createdAt = lastWhere().createdAt as { gte?: Date };
    expect((createdAt.gte as Date).toISOString()).toBe('2026-09-06T00:00:00.000Z');
    // Платіж о 15:00 того ж дня МУСИТЬ проходити нижню межу.
    const paidAt = new Date('2026-09-06T15:00:00.000Z');
    expect(paidAt.getTime()).toBeGreaterThanOrEqual((createdAt.gte as Date).getTime());
  });

  it('dateFrom+dateTo разом → повний закритий інтервал [00:00:00.000, 23:59:59.999]', async () => {
    await service.findAll(ORG, { dateFrom: '2026-09-01', dateTo: '2026-09-06' });
    const createdAt = lastWhere().createdAt as { gte?: Date; lte?: Date };
    expect((createdAt.gte as Date).toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect((createdAt.lte as Date).toISOString()).toBe('2026-09-06T23:59:59.999Z');
  });

  it('без дат → where.createdAt відсутній (немає фільтра діапазону)', async () => {
    await service.findAll(ORG, {});
    expect(lastWhere().createdAt).toBeUndefined();
  });

  // ── 2. fiscalStatus фільтр (enum-guard review-fix) ────────────────────────

  it('fiscalStatus=FAILED (валідний enum) → where.fiscalStatus=FAILED', async () => {
    await service.findAll(ORG, { fiscalStatus: 'FAILED' });
    expect(lastWhere().fiscalStatus).toBe('FAILED');
  });

  it("fiscalStatus='none' → where.fiscalStatus=null (IS NULL — метод без фіскалізації)", async () => {
    await service.findAll(ORG, { fiscalStatus: 'none' });
    expect(lastWhere().fiscalStatus).toBeNull();
    expect('fiscalStatus' in lastWhere()).toBe(true);
  });

  it('fiscalStatus=garbage → фільтр НЕ застосовано (без 500) — MUTATION guard enum-Set', async () => {
    // МУТАЦІЯ-guard: якщо прибрати FISCAL_STATUS_VALUES.has() перевірку, 'xxx' дійшло б до
    // Prisma → HTTP 500. Валідне значення enum ігнорує невідоме → жодного where.fiscalStatus.
    await expect(service.findAll(ORG, { fiscalStatus: 'xxx' })).resolves.toBeDefined();
    expect('fiscalStatus' in lastWhere()).toBe(false);
  });

  it('fiscalStatus=DONE (інший валідний enum) → where.fiscalStatus=DONE', async () => {
    await service.findAll(ORG, { fiscalStatus: 'DONE' });
    expect(lastWhere().fiscalStatus).toBe('DONE');
  });

  it("fiscalStatus порожній рядок → фільтр НЕ застосовано (як 'усі')", async () => {
    await service.findAll(ORG, { fiscalStatus: '' });
    expect('fiscalStatus' in lastWhere()).toBe(false);
  });

  // ── 3. method + counterpartyId фільтри ────────────────────────────────────

  it('method=card → where.method=card (eq)', async () => {
    await service.findAll(ORG, { method: 'card' });
    expect(lastWhere().method).toBe('card');
  });

  it('counterpartyId валідний (org-scoped) → застосовано у where; findFirst перевіряє orgId', async () => {
    prisma.counterparty.findFirst.mockResolvedValue({ id: CP_ID });
    await service.findAll(ORG, { counterpartyId: CP_ID });
    expect(prisma.counterparty.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: CP_ID, orgId: ORG, deletedAt: null }),
      }),
    );
    expect(lastWhere().counterpartyId).toBe(CP_ID);
  });

  it('counterpartyId чужої org → NotFound (tenant isolation), findMany НЕ викликано', async () => {
    prisma.counterparty.findFirst.mockResolvedValue(null);
    await expect(service.findAll(ORG, { counterpartyId: CP_ID })).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });

  it('where завжди містить orgId (tenant isolation базово)', async () => {
    await service.findAll(ORG, {});
    expect(lastWhere().orgId).toBe(ORG);
  });

  it('pagination: limit клампиться у [1,200], page у [1,∞) — DoS-hardening', async () => {
    await service.findAll(ORG, { limit: 999999, page: -5 });
    const args = prisma.payment.findMany.mock.calls[0][0] as { take: number; skip: number };
    expect(args.take).toBe(200); // clamp зверху
    expect(args.skip).toBe(0); // page клампиться до 1 → skip 0
  });

  // ── 4. findOne ────────────────────────────────────────────────────────────

  it('findOne валідний → toDto з counterpartyName та sourceName', async () => {
    prisma.payment.findFirst.mockResolvedValue(
      paymentRow({ bankAccount: { name: 'ПриватБанк' }, sourceType: 'BANK_ACCOUNT' }),
    );
    const dto = await service.findOne(ORG, PAY_ID);
    expect(prisma.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: PAY_ID, orgId: ORG } }),
    );
    expect(dto.id).toBe(PAY_ID);
    expect(dto.counterpartyName).toBe('Петренко Іван');
    expect(dto.sourceName).toBe('ПриватБанк');
  });

  it('findOne cross-org / missing → NotFound (findFirst повертає null)', async () => {
    prisma.payment.findFirst.mockResolvedValue(null);
    await expect(service.findOne(ORG, PAY_ID)).rejects.toThrow(NotFoundException);
  });

  // ── 5. toDto sourceName (bank → cash → null) ──────────────────────────────

  it('toDto: bankAccount.name присутній → sourceName = назва банку', async () => {
    prisma.payment.findFirst.mockResolvedValue(paymentRow({ bankAccount: { name: 'Моно' } }));
    expect((await service.findOne(ORG, PAY_ID)).sourceName).toBe('Моно');
  });

  it('toDto: лише cashRegister.name → sourceName = назва каси', async () => {
    prisma.payment.findFirst.mockResolvedValue(paymentRow({ cashRegister: { name: 'Каса №1' } }));
    expect((await service.findOne(ORG, PAY_ID)).sourceName).toBe('Каса №1');
  });

  it('toDto: ні bank ні cash → sourceName = null', async () => {
    prisma.payment.findFirst.mockResolvedValue(paymentRow());
    expect((await service.findOne(ORG, PAY_ID)).sourceName).toBeNull();
  });

  it('toDto: обидва присутні → пріоритет банку (bank ?? cash)', async () => {
    prisma.payment.findFirst.mockResolvedValue(
      paymentRow({ bankAccount: { name: 'Банк' }, cashRegister: { name: 'Каса' } }),
    );
    expect((await service.findOne(ORG, PAY_ID)).sourceName).toBe('Банк');
  });

  // ── 6. retryFiscal ────────────────────────────────────────────────────────

  const failedPayment = (over: Record<string, unknown> = {}) => ({
    id: PAY_ID,
    fiscalStatus: 'FAILED',
    fiscalReceiptId: null,
    method: 'card',
    amount: 500,
    workOrderId: null,
    ...over,
  });

  it('retryFiscal: FAILED + без receiptId → update QUEUED + checkboxQueue.add', async () => {
    prisma.payment.findFirst
      .mockResolvedValueOnce(failedPayment()) // select у retryFiscal
      .mockResolvedValueOnce(paymentRow({ fiscalStatus: 'QUEUED' })); // findOne у кінці
    await service.retryFiscal(ORG, PAY_ID);

    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: PAY_ID, orgId: ORG },
        data: expect.objectContaining({ fiscalStatus: 'QUEUED', fiscalError: null }),
      }),
    );
    expect(checkboxQueue.add).toHaveBeenCalledTimes(1);
    expect(checkboxQueue.add).toHaveBeenCalledWith(
      'fiscal-receipt',
      expect.objectContaining({ paymentId: PAY_ID, orgId: ORG, method: 'card', amount: 500 }),
      expect.objectContaining({ attempts: 288 }),
    );
  });

  it('retryFiscal: вже має fiscalReceiptId → 400 «уже пробито», БЕЗ enqueue (idempotency)', async () => {
    prisma.payment.findFirst.mockResolvedValue(
      failedPayment({ fiscalReceiptId: 'RCPT-1', fiscalStatus: 'FAILED' }),
    );
    await expect(service.retryFiscal(ORG, PAY_ID)).rejects.toThrow(/уже пробито/);
    expect(checkboxQueue.add).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  it('retryFiscal: статус DONE (не FAILED) → 400, БЕЗ enqueue', async () => {
    prisma.payment.findFirst.mockResolvedValue(failedPayment({ fiscalStatus: 'DONE' }));
    await expect(service.retryFiscal(ORG, PAY_ID)).rejects.toThrow(/лише для чеків/);
    expect(checkboxQueue.add).not.toHaveBeenCalled();
  });

  it('retryFiscal: статус QUEUED (не FAILED) → 400', async () => {
    prisma.payment.findFirst.mockResolvedValue(failedPayment({ fiscalStatus: 'QUEUED' }));
    await expect(service.retryFiscal(ORG, PAY_ID)).rejects.toThrow(BadRequestException);
    expect(checkboxQueue.add).not.toHaveBeenCalled();
  });

  it('retryFiscal: статус SKIPPED (не FAILED) → 400', async () => {
    prisma.payment.findFirst.mockResolvedValue(failedPayment({ fiscalStatus: 'SKIPPED' }));
    await expect(service.retryFiscal(ORG, PAY_ID)).rejects.toThrow(BadRequestException);
    expect(checkboxQueue.add).not.toHaveBeenCalled();
  });

  it('retryFiscal: queue.add reject (Redis лежить) → .catch ставить FAILED, create НЕ кидає', async () => {
    prisma.payment.findFirst
      .mockResolvedValueOnce(failedPayment())
      .mockResolvedValueOnce(paymentRow({ fiscalStatus: 'FAILED' }));
    checkboxQueue.add.mockRejectedValue(new Error('Redis down'));

    // НЕ кидає — offline-first: помилка черги не валить HTTP-запит.
    await expect(service.retryFiscal(ORG, PAY_ID)).resolves.toBeDefined();
    // update викликано двічі: 1) QUEUED (на старті), 2) FAILED (у .catch).
    expect(prisma.payment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fiscalStatus: 'FAILED',
          fiscalError: expect.stringContaining('Черга недоступна'),
        }),
      }),
    );
  });

  it('retryFiscal: cross-org id → NotFound (tenant-scoped), БЕЗ enqueue/update', async () => {
    prisma.payment.findFirst.mockResolvedValue(null);
    await expect(service.retryFiscal(ORG, PAY_ID)).rejects.toThrow(NotFoundException);
    expect(checkboxQueue.add).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
  });

  it('retryFiscal: гейт receiptId перевіряється ПЕРЕД гейтом статусу (правильний порядок)', async () => {
    // Payment FAILED але з receiptId → має спрацювати «уже пробито», не «лише для FAILED».
    prisma.payment.findFirst.mockResolvedValue(
      failedPayment({ fiscalStatus: 'FAILED', fiscalReceiptId: 'RCPT-1' }),
    );
    await expect(service.retryFiscal(ORG, PAY_ID)).rejects.toThrow(/уже пробито/);
  });
});
