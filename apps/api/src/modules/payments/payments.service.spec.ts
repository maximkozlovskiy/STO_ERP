import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SettlementsService } from '../settlements/settlements.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WorkOrdersService } from '../work-orders/work-orders.service';
import { LoyaltyService } from '../loyalty/loyalty.service';

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
