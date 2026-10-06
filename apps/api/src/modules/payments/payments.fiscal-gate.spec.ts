/**
 * PaymentsService — requiresFiscal-гейт і enqueue чека (Bug #661/#662)
 *
 * Виділено з `payments.service.spec.ts` (був 1720 рядків, 5 незалежних top-level
 * describe) 2026-10-06. Кейси перенесені ДОСЛІВНО, назви describe не змінені —
 * інакше `fullName` у test-baseline.json розійшовся б.
 *
 * `exchangeRatesMock()` — з `./payments.spec-fixture` (був у преамбулі, 4 вживання).
 */

import { Test } from '@nestjs/testing';
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

describe('PaymentsService — Bug #661/#662 requiresFiscal-гейт + enqueue .catch()', () => {
  let service: PaymentsService;
  let prisma: {
    counterparty: { findFirst: ReturnType<typeof vi.fn> };
    workOrder: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    invoice: { findFirst: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    garageBranch: { findFirst: ReturnType<typeof vi.fn> };
    payment: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    paymentMethodConfig: { findFirst: ReturnType<typeof vi.fn> };
    cashRegister: { findFirst: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let settlements: { createTransaction: ReturnType<typeof vi.fn> };
  let checkboxQueue: { add: ReturnType<typeof vi.fn> };
  let loyalty: { queueEarn: ReturnType<typeof vi.fn> };

  const ORG = 'org-1';
  const CP_ID = '22222222-2222-4222-8222-222222222222';
  const PAY_ID = '44444444-4444-4444-8444-444444444444';
  const CASH_ID = '55555555-5555-4555-8555-555555555555';

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
      cashRegister: { findFirst: vi.fn() },
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

  it('тригер каси: оплата у ФІСКАЛЬНУ касу → fiscalStatus="QUEUED" навіть при requiresFiscal=false', async () => {
    // Метод НЕ вимагає фіскалізації, але каса-призначення фіскальна → чек усе одно ставиться.
    prisma.paymentMethodConfig.findFirst.mockResolvedValue({ requiresFiscal: false });
    prisma.cashRegister.findFirst.mockResolvedValue({ id: CASH_ID, isFiscal: true });

    await service.create(
      ORG,
      { ...dto, sourceType: 'CASH_REGISTER', cashRegisterId: CASH_ID },
      'user-1',
    );

    expect(checkboxQueue.add).toHaveBeenCalledTimes(1);
    expect(lastCreateData?.fiscalStatus).toBe('QUEUED');
  });

  it('тригер каси: оплата у ЗВИЧАЙНУ касу + requiresFiscal=false → fiscalStatus=null (без чека)', async () => {
    prisma.paymentMethodConfig.findFirst.mockResolvedValue({ requiresFiscal: false });
    prisma.cashRegister.findFirst.mockResolvedValue({ id: CASH_ID, isFiscal: false });

    await service.create(
      ORG,
      { ...dto, sourceType: 'CASH_REGISTER', cashRegisterId: CASH_ID },
      'user-1',
    );

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
