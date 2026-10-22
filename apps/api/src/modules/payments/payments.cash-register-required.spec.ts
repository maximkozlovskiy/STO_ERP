/**
 * PaymentsService — готівка лише через касу (BR-PAY-019).
 *
 * Оплата способом «Готівка» (`cash`) мусить мати касу: з запиту або касу за замовчуванням способу
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
      paymentMethodConfig: { findFirst: vi.fn().mockResolvedValue({ requiresFiscal: false }) },
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
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return Promise.resolve(undefined);
      }),
    };
    cash = { createOperation: vi.fn().mockResolvedValue(undefined) };

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
        { provide: getQueueToken('checkbox'), useValue: { add: vi.fn() } },
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
    prisma.paymentMethodConfig.findFirst.mockResolvedValue({
      requiresFiscal: false,
      defaultSourceType: 'CASH_REGISTER',
      defaultCashRegisterId: DEFAULT_CASH_ID,
      defaultBankAccountId: null,
    });

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
    prisma.paymentMethodConfig.findFirst.mockResolvedValue({
      requiresFiscal: false,
      defaultSourceType: 'CASH_REGISTER',
      defaultCashRegisterId: DEFAULT_CASH_ID,
      defaultBankAccountId: null,
    });

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
    prisma.paymentMethodConfig.findFirst.mockResolvedValue({
      requiresFiscal: false,
      defaultSourceType: 'CASH_REGISTER',
      defaultCashRegisterId: DEFAULT_CASH_ID,
      defaultBankAccountId: null,
    });
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

    prisma.paymentMethodConfig.findFirst.mockResolvedValue({
      requiresFiscal: false,
      defaultSourceType: 'BANK_ACCOUNT',
      defaultCashRegisterId: null,
      defaultBankAccountId: BANK_ID,
    });
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
      prisma.paymentMethodConfig.findFirst.mockResolvedValue({
        requiresFiscal: false,
        defaultSourceType,
        defaultCashRegisterId: null,
        defaultBankAccountId: defaultSourceType ? BANK_ID : null,
      });

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
      prisma.paymentMethodConfig.findFirst.mockResolvedValue({
        requiresFiscal: false,
        defaultSourceType: 'CASH_REGISTER',
        defaultCashRegisterId: DEFAULT_CASH_ID,
        defaultBankAccountId: null,
      });
      await service.create(ORG, { ...dto, method: 'card_terminal' }, 'user-1');
      expect(lastCreateData).toMatchObject({
        sourceType: 'CASH_REGISTER',
        cashRegisterId: DEFAULT_CASH_ID,
      });
    });

    // guards: BR-PAY-023
    it('рахунок за замовчуванням видалено → 400, а не оплата без рахунку', async () => {
      prisma.paymentMethodConfig.findFirst.mockResolvedValue({
        requiresFiscal: false,
        defaultSourceType: 'BANK_ACCOUNT',
        defaultCashRegisterId: null,
        defaultBankAccountId: BANK_ID,
      });
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
});
