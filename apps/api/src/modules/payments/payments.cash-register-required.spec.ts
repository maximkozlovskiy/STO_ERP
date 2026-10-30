/**
 * PaymentsService — готівка лише через касу (BR-PAY-019) і спосіб оплати з довідника (BR-PAY-027).
 *
 * «Готівка» — ознака способу в довіднику (`PaymentMethodConfig.isCash`), не код `cash`.
 * Фейковий довідник нижче ВИКОНУЄ `where` (код, `deletedAt: null`) над рядками способів.
 *
 * Оплата способом-«готівкою» мусить мати касу: з запиту або касу за замовчуванням способу
 * оплати. Без каси борг гасився, а каса й її історія про оплату не знали (TECH-DEBT §10 п. 17).
 * Правило діє ПІСЛЯ розв'язання рахунку-призначення, тож застаріле замовчування (касу видалено,
 * BR-PAY-002 мовчки знімає його) теж дає 400. Решта способів — BR-PAY-023 (рахунок обов'язковий), нижче.
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
import { domainEventMock } from '../../common/testing/prisma-mock';

const ORG = 'org-1';
const CP_ID = '22222222-2222-4222-8222-222222222222';
const PAY_ID = '44444444-4444-4444-8444-444444444444';
const DEFAULT_CASH_ID = '66666666-6666-4666-8666-666666666666';
const EXPLICIT_CASH_ID = '77777777-7777-4777-8777-777777777777';
const BANK_ID = '88888888-8888-4888-8888-888888888888';
const CASH_MSG = 'Для оплати готівкою вкажіть касу';

type Fn = ReturnType<typeof vi.fn>;

describe('PaymentsService — готівка лише через касу (BR-PAY-019)', () => {
  let service: PaymentsService;
  let prisma: {
    domainEvent: ReturnType<typeof domainEventMock>;
    counterparty: { findFirst: Fn };
    workOrder: { findFirst: Fn };
    invoice: { findFirst: Fn };
    payment: { create: Fn; update: Fn };
    paymentMethodConfig: { findFirst: Fn };
    cashRegister: { findFirst: Fn };
    bankAccount: { findFirst: Fn };
    $transaction: Fn;
  };
  let cash: { createOperation: Fn };
  let queue: { add: Fn };
  /** Довідник способів оплати організації ORG. */
  let methods: Array<{
    code: string;
    isCash?: boolean;
    isActive?: boolean;
    requiresFiscal?: boolean;
    deleted?: boolean;
  }>;
  /** Призначення за замовчуванням, яке кейс задає будь-якому способу. */
  let methodDefaults: Record<string, unknown>;
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
          companyName: 'ТОВ «Клієнт»',
        }),
      },
      workOrder: { findFirst: vi.fn().mockResolvedValue(null) },
      invoice: { findFirst: vi.fn().mockResolvedValue(null) },
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
            method: args.data.method,
            notes: null,
            fiscalReceiptId: null,
            fiscalStatus: null,
            fiscalError: null,
            sourceType: args.data.sourceType ?? null,
            cashRegisterId: args.data.cashRegisterId ?? null,
            bankAccountId: args.data.bankAccountId ?? null,
            currencyId: null,
            amountBase: 100,
            rateUsed: 1,
            currency: null,
            createdAt: new Date(),
            counterparty: { firstName: null, lastName: null, companyName: 'ТОВ «Клієнт»' },
          });
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      paymentMethodConfig: { findFirst: vi.fn() },
      // Будь-яка запитана каса жива й нефіскальна; видалену/чужу кейс задає сам.
      cashRegister: {
        findFirst: vi
          .fn()
          .mockImplementation((args: { where: { id: string } }) =>
            Promise.resolve({ id: args.where.id, isFiscal: false, currencyId: null }),
          ),
      },
      bankAccount: {
        findFirst: vi.fn().mockResolvedValue({ id: BANK_ID, currencyId: null }),
      },
      domainEvent: domainEventMock(),
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return Promise.resolve(undefined);
      }),
    };
    cash = { createOperation: vi.fn().mockResolvedValue(undefined) };
    queue = { add: vi.fn().mockResolvedValue(undefined) };
    methods = [
      { code: 'cash', isCash: true },
      { code: 'card_terminal' },
      { code: 'bank' },
      { code: 'monobank_qr' },
    ];
    prisma.paymentMethodConfig.findFirst.mockImplementation(
      (args: { where: { orgId: string; code: string; deletedAt?: null } }) => {
        const row = methods.find(
          m =>
            m.code === args.where.code &&
            (args.where.deletedAt !== null || !m.deleted) &&
            args.where.orgId === ORG,
        );
        return Promise.resolve(
          row
            ? {
                isActive: row.isActive ?? true,
                isCash: row.isCash ?? false,
                requiresFiscal: row.requiresFiscal ?? false,
                defaultSourceType: null,
                defaultCashRegisterId: null,
                defaultBankAccountId: null,
                ...methodDefaults,
              }
            : null,
        );
      },
    );
    methodDefaults = {};

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
        { provide: AuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        { provide: CashService, useValue: cash },
        { provide: ExchangeRatesService, useValue: exchangeRatesMock() },
        { provide: getQueueToken('checkbox'), useValue: queue },
      ],
    }).compile();
    service = module.get(PaymentsService);
  });

  const cashDto = { counterpartyId: CP_ID, amount: 100, method: 'cash' };

  // guards: BR-PAY-019
  it('готівка без каси в запиті й без каси за замовчуванням → 400, платежу немає', async () => {
    await expect(service.create(ORG, cashDto, 'user-1')).rejects.toThrow(
      new BadRequestException(CASH_MSG),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(cash.createOperation).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-019
  it('готівка з касою за замовчуванням способу → рядок у цій касі, платіж несе касу', async () => {
    methodDefaults = {
      defaultSourceType: 'CASH_REGISTER',
      defaultCashRegisterId: DEFAULT_CASH_ID,
      defaultBankAccountId: null,
    };

    await service.create(ORG, cashDto, 'user-1');

    expect(lastCreateData).toMatchObject({
      sourceType: 'CASH_REGISTER',
      cashRegisterId: DEFAULT_CASH_ID,
    });
    expect(cash.createOperation).toHaveBeenCalledTimes(1);
    expect(cash.createOperation).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({
        cashRegisterId: DEFAULT_CASH_ID,
        direction: 'IN',
        amount: 100,
        reason: 'SALE_PAYMENT',
        documentType: 'Payment',
        documentId: PAY_ID,
      }),
      prisma,
    );
  });

  // guards: BR-PAY-019
  it('явна каса в запиті перемагає касу за замовчуванням', async () => {
    methodDefaults = {
      defaultSourceType: 'CASH_REGISTER',
      defaultCashRegisterId: DEFAULT_CASH_ID,
      defaultBankAccountId: null,
    };

    await service.create(
      ORG,
      { ...cashDto, sourceType: 'CASH_REGISTER', cashRegisterId: EXPLICIT_CASH_ID },
      'user-1',
    );

    expect(lastCreateData).toMatchObject({ cashRegisterId: EXPLICIT_CASH_ID });
    expect(cash.createOperation).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ cashRegisterId: EXPLICIT_CASH_ID }),
      prisma,
    );
    expect(cash.createOperation).not.toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ cashRegisterId: DEFAULT_CASH_ID }),
      expect.anything(),
    );
  });

  // guards: BR-PAY-019
  it('застаріле замовчування (касу видалено) → 400, а не оплата повз касу', async () => {
    methodDefaults = {
      defaultSourceType: 'CASH_REGISTER',
      defaultCashRegisterId: DEFAULT_CASH_ID,
      defaultBankAccountId: null,
    };
    prisma.cashRegister.findFirst.mockResolvedValue(null);

    await expect(service.create(ORG, cashDto, 'user-1')).rejects.toThrow(
      new BadRequestException(CASH_MSG),
    );
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(cash.createOperation).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-019
  it('готівка, але призначення — банківський рахунок (явно чи за замовчуванням) → 400', async () => {
    await expect(
      service.create(
        ORG,
        { ...cashDto, sourceType: 'BANK_ACCOUNT', bankAccountId: BANK_ID },
        'user-1',
      ),
    ).rejects.toThrow(new BadRequestException(CASH_MSG));

    methodDefaults = {
      defaultSourceType: 'BANK_ACCOUNT',
      defaultCashRegisterId: null,
      defaultBankAccountId: BANK_ID,
    };
    await expect(service.create(ORG, cashDto, 'user-1')).rejects.toThrow(
      new BadRequestException(CASH_MSG),
    );
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  // guards: BR-PAY-002, BR-PAY-019
  it.each([
    ['готівка, замовчування немає', 'cash', null],
    ['термінал, замовчування — банківський рахунок', 'card_terminal', 'BANK_ACCOUNT'],
  ] as const)(
    'каса в запиті без sourceType (%s) → тип із id, оплата лягає в цю касу',
    async (_label, method, defaultSourceType) => {
      methodDefaults = {
        defaultSourceType,
        defaultCashRegisterId: null,
        defaultBankAccountId: defaultSourceType ? BANK_ID : null,
      };

      await service.create(ORG, { ...cashDto, method, cashRegisterId: EXPLICIT_CASH_ID }, 'user-1');

      expect(lastCreateData).toMatchObject({
        sourceType: 'CASH_REGISTER',
        cashRegisterId: EXPLICIT_CASH_ID,
        bankAccountId: null,
      });
      expect(cash.createOperation).toHaveBeenCalledWith(
        ORG,
        expect.objectContaining({ cashRegisterId: EXPLICIT_CASH_ID }),
        prisma,
      );
    },
  );

  /**
   * BR-PAY-023 (рішення власника 2026-10-22): безготівкова оплата мусить мати призначення —
   * банківський рахунок. Виняток: спосіб із касою за замовчуванням (картка через термінал із ПРРО)
   * іде в касу. Без жодного призначення — 400. Онлайн-оплата (QR від шлюзу, `onlinePaymentIntentId`)
   * під правило не підпадає. Раніше такі оплати гасили борг, а на жодному рахунку грошей не було.
   */
  describe('безготівкова оплата лише з призначенням (BR-PAY-023)', () => {
    const dto = { counterpartyId: CP_ID, amount: 100 };

    // guards: BR-PAY-023
    it.each(['card_terminal', 'bank', 'monobank_qr'])(
      'спосіб %s без рахунку в запиті й без замовчування → 400, платежу немає',
      async method => {
        await expect(service.create(ORG, { ...dto, method }, 'user-1')).rejects.toThrow(
          'Безготівкова оплата: оберіть банківський рахунок',
        );
        expect(prisma.payment.create).not.toHaveBeenCalled();
      },
    );

    // guards: BR-PAY-023
    it('переказ з рахунком у запиті → оплата на цей рахунок', async () => {
      await service.create(ORG, { ...dto, method: 'bank', bankAccountId: BANK_ID }, 'user-1');
      expect(lastCreateData).toMatchObject({ sourceType: 'BANK_ACCOUNT', bankAccountId: BANK_ID });
    });

    // guards: BR-PAY-023
    it('картка через термінал з касою за замовчуванням → у касу, без рахунку', async () => {
      methodDefaults = {
        defaultSourceType: 'CASH_REGISTER',
        defaultCashRegisterId: DEFAULT_CASH_ID,
        defaultBankAccountId: null,
      };
      await service.create(ORG, { ...dto, method: 'card_terminal' }, 'user-1');
      expect(lastCreateData).toMatchObject({
        sourceType: 'CASH_REGISTER',
        cashRegisterId: DEFAULT_CASH_ID,
      });
    });

    // guards: BR-PAY-023
    it('рахунок за замовчуванням видалено → 400, а не оплата без рахунку', async () => {
      methodDefaults = {
        defaultSourceType: 'BANK_ACCOUNT',
        defaultCashRegisterId: null,
        defaultBankAccountId: BANK_ID,
      };
      prisma.bankAccount.findFirst.mockResolvedValue(null);
      await expect(service.create(ORG, { ...dto, method: 'bank' }, 'user-1')).rejects.toThrow(
        'Безготівкова оплата: оберіть банківський рахунок',
      );
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    // guards: BR-PAY-023
    it('онлайн-оплата від шлюзу (onlinePaymentIntentId) — без призначення, як раніше', async () => {
      await service.create(
        ORG,
        { ...dto, method: 'monobank_qr', onlinePaymentIntentId: 'intent-1' },
        'user-1',
      );
      expect(prisma.payment.create).toHaveBeenCalledTimes(1);
      expect(lastCreateData).toMatchObject({ sourceType: null, bankAccountId: null });
    });
  });

  /**
   * BR-PAY-019 за ознакою довідника: «готівкою» є спосіб з `isCash`, а не код `cash` (рішення
   * власника 2026-10-30, TECH-DEBT (б) п. 45). НДІ створює коди великими літерами (`CASH`), і такий
   * власний «готівковий» спосіб раніше проходив без каси.
   */
  describe('готівка — ознака способу в довіднику (BR-PAY-019)', () => {
    // guards: BR-PAY-019
    it('власний спосіб CASH з isCash без каси → 400, як «Готівка»', async () => {
      methods.push({ code: 'CASH', isCash: true });
      await expect(
        service.create(ORG, { ...cashDto, method: 'CASH' }, 'user-1', undefined, {
          fromRequest: true,
        }),
      ).rejects.toThrow(new BadRequestException(CASH_MSG));
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    // guards: BR-PAY-019
    it('онлайн-оплата від шлюзу: ознака isCash на QR-способі не дає 400, чек — CASHLESS', async () => {
      methods = methods.map(m =>
        m.code === 'monobank_qr' ? { ...m, isCash: true, requiresFiscal: true } : m,
      );
      await service.create(
        ORG,
        { ...cashDto, method: 'monobank_qr', onlinePaymentIntentId: 'intent-1' },
        'user-1',
      );
      expect(prisma.payment.create).toHaveBeenCalledTimes(1);
      expect(queue.add.mock.calls[0]?.[1]).toMatchObject({ method: 'monobank_qr', isCash: false });
    });

    // guards: BR-PAY-019
    it('намір у запиті людини (POST /payments) ознаку не обходить → 400', async () => {
      methods.push({ code: 'CASH', isCash: true });
      await expect(
        service.create(
          ORG,
          { ...cashDto, method: 'CASH', onlinePaymentIntentId: 'intent-2' },
          'user-1',
          undefined,
          { fromRequest: true },
        ),
      ).rejects.toThrow(new BadRequestException(CASH_MSG));
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    // guards: BR-PAY-019
    it('код cash без ознаки isCash — не готівка: з рахунком у запиті проходить', async () => {
      methods[0] = { code: 'cash', isCash: false };
      await service.create(ORG, { ...cashDto, bankAccountId: BANK_ID }, 'user-1');
      expect(lastCreateData).toMatchObject({ sourceType: 'BANK_ACCOUNT', bankAccountId: BANK_ID });
    });

    // guards: BR-PAY-019
    it('чек ПРРО: тип оплати — за ознакою (isCash у job), не за кодом', async () => {
      methods.push({ code: 'CASH', isCash: true, requiresFiscal: true });
      methods.push({ code: 'cash_like', requiresFiscal: true });
      await service.create(
        ORG,
        {
          ...cashDto,
          method: 'CASH',
          sourceType: 'CASH_REGISTER',
          cashRegisterId: EXPLICIT_CASH_ID,
        },
        'user-1',
      );
      await service.create(
        ORG,
        { ...cashDto, method: 'cash_like', bankAccountId: BANK_ID },
        'user-1',
      );
      const jobs = queue.add.mock.calls.map(c => c[1] as { method: string; isCash: boolean });
      expect(jobs).toEqual([
        expect.objectContaining({ method: 'CASH', isCash: true }),
        expect.objectContaining({ method: 'cash_like', isCash: false }),
      ]);
    });
  });

  /**
   * BR-PAY-027 (рішення власника 2026-10-30, TECH-DEBT (б) п. 45): `POST /payments` приймає лише
   * спосіб, що є в довіднику, активний і не видалений; інакше 400 до транзакції. Раніше будь-який
   * код (`Cash`, вимкнений, видалений) давав оплату. Внутрішні викликачі (рознесення виписки —
   * `bank`, онлайн-оплата, каса) під правило не підпадають.
   */
  describe('спосіб оплати із запиту — лише з довідника (BR-PAY-027)', () => {
    const METHOD_MSG = /Спосіб оплати «.+» не знайдено, вимкнено або видалено/;
    const req = { counterpartyId: CP_ID, amount: 100, bankAccountId: BANK_ID };
    const fromRequest = { fromRequest: true };

    // guards: BR-PAY-027
    it.each([
      ['невідомий код', 'Cash', {}],
      ['вимкнений', 'card_terminal', { isActive: false }],
      ['видалений', 'card_terminal', { deleted: true }],
    ] as const)('%s (%s) → 400, оплати немає', async (_label, method, patch) => {
      methods = methods.map(m => (m.code === method ? { ...m, ...patch } : m));
      await expect(
        service.create(ORG, { ...req, method }, 'user-1', undefined, fromRequest),
      ).rejects.toThrow(METHOD_MSG);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    // guards: BR-PAY-027
    it('наявний активний спосіб → оплата проходить', async () => {
      await service.create(
        ORG,
        { ...req, method: 'card_terminal' },
        'user-1',
        undefined,
        fromRequest,
      );
      expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    });

    // guards: BR-PAY-027
    it('внутрішній виклик (рознесення виписки, спосіб bank поза довідником) — без перевірки', async () => {
      methods = methods.filter(m => m.code !== 'bank');
      await service.create(ORG, { ...req, method: 'bank' }, 'user-1');
      expect(prisma.payment.create).toHaveBeenCalledTimes(1);
    });
  });
});
