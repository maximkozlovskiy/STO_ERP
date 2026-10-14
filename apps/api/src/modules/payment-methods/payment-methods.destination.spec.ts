/**
 * PaymentMethodsService — куди надходять кошти способу оплати (каса чи банківський рахунок
 * за замовчуванням). Платіж бере їх, коли в запиті рахунку-призначення немає (BR-PAY-002), а
 * для готівки без каси в запиті це єдине джерело каси (BR-PAY-019).
 *
 * Три поля пишуться разом: тип і id узгоджені, id іншого типу обнуляється, `null` знімає все.
 * Каса чи рахунок — лише живі й своєї організації.
 */
import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PaymentMethodsService } from './payment-methods.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';

const ORG = 'org-1';
const PM_ID = 'pm-cash';
const CASH_ID = '66666666-6666-4666-8666-666666666666';
const BANK_ID = '88888888-8888-4888-8888-888888888888';

type Fn = ReturnType<typeof vi.fn>;

const row = (over: Record<string, unknown> = {}) => ({
  id: PM_ID,
  orgId: ORG,
  code: 'cash',
  name: 'Готівка',
  isActive: true,
  isSystem: true,
  sortOrder: 1,
  requiresFiscal: false,
  defaultSourceType: null,
  defaultCashRegisterId: null,
  defaultBankAccountId: null,
  updatedAt: new Date('2026-10-14T10:00:00.000Z'),
  ...over,
});

describe('PaymentMethodsService — куди надходять кошти', () => {
  let service: PaymentMethodsService;
  let prisma: {
    paymentMethodConfig: { findFirst: Fn; findMany: Fn; update: Fn; create: Fn };
    cashRegister: { findFirst: Fn; findMany: Fn };
    bankAccount: { findFirst: Fn; findMany: Fn };
  };
  let cache: { get: Fn; set: Fn; del: Fn };

  beforeEach(async () => {
    cache = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      del: vi.fn().mockResolvedValue(undefined),
    };
    prisma = {
      paymentMethodConfig: {
        findFirst: vi.fn().mockResolvedValue({ id: PM_ID, isSystem: true }),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi
          .fn()
          .mockImplementation((args: { data: Record<string, unknown> }) =>
            Promise.resolve(row(args.data)),
          ),
        create: vi
          .fn()
          .mockImplementation((args: { data: Record<string, unknown> }) =>
            Promise.resolve(row({ ...args.data, id: 'pm-new', isSystem: false })),
          ),
      },
      cashRegister: {
        findFirst: vi.fn().mockResolvedValue({ id: CASH_ID }),
        findMany: vi.fn().mockResolvedValue([{ id: CASH_ID, name: 'Каса 1' }]),
      },
      bankAccount: {
        findFirst: vi.fn().mockResolvedValue({ id: BANK_ID }),
        findMany: vi.fn().mockResolvedValue([{ id: BANK_ID, name: 'ПриватБанк' }]),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        PaymentMethodsService,
        { provide: PrismaService, useValue: prisma },
        { provide: CacheService, useValue: cache },
      ],
    }).compile();
    service = module.get(PaymentMethodsService);
  });

  const updateData = () =>
    (prisma.paymentMethodConfig.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;

  it('каса за замовчуванням: пишуться тип і каса, рахунок обнуляється; відповідь несе назву каси', async () => {
    const res = await service.update(ORG, PM_ID, {
      defaultSourceType: 'CASH_REGISTER',
      defaultCashRegisterId: CASH_ID,
    });

    expect(updateData()).toEqual({
      defaultSourceType: 'CASH_REGISTER',
      defaultCashRegisterId: CASH_ID,
      defaultBankAccountId: null,
    });
    expect(prisma.cashRegister.findFirst).toHaveBeenCalledWith({
      where: { id: CASH_ID, orgId: ORG, deletedAt: null },
      select: { id: true },
    });
    expect(res).toMatchObject({
      defaultSourceType: 'CASH_REGISTER',
      defaultCashRegisterId: CASH_ID,
      defaultBankAccountId: null,
      defaultDestinationName: 'Каса 1',
    });
    expect(cache.del).toHaveBeenCalled();
  });

  it('зміна типу на банківський рахунок обнуляє касу', async () => {
    const res = await service.update(ORG, PM_ID, {
      defaultSourceType: 'BANK_ACCOUNT',
      defaultBankAccountId: BANK_ID,
    });

    expect(updateData()).toEqual({
      defaultSourceType: 'BANK_ACCOUNT',
      defaultCashRegisterId: null,
      defaultBankAccountId: BANK_ID,
    });
    expect(prisma.bankAccount.findFirst).toHaveBeenCalledWith({
      where: { id: BANK_ID, orgId: ORG, deletedAt: null },
      select: { id: true },
    });
    expect(res.defaultDestinationName).toBe('ПриватБанк');
  });

  it('тип не вказано — виводиться з переданого id', async () => {
    await service.update(ORG, PM_ID, { defaultCashRegisterId: CASH_ID });

    expect(updateData()).toEqual({
      defaultSourceType: 'CASH_REGISTER',
      defaultCashRegisterId: CASH_ID,
      defaultBankAccountId: null,
    });
  });

  it('null знімає призначення: усі три поля null, без читання кас і рахунків', async () => {
    const res = await service.update(ORG, PM_ID, { defaultSourceType: null });

    expect(updateData()).toEqual({
      defaultSourceType: null,
      defaultCashRegisterId: null,
      defaultBankAccountId: null,
    });
    expect(prisma.cashRegister.findFirst).not.toHaveBeenCalled();
    expect(prisma.bankAccount.findFirst).not.toHaveBeenCalled();
    expect(res.defaultDestinationName).toBeNull();
  });

  it('запит без полів призначення їх не чіпає', async () => {
    await service.update(ORG, PM_ID, { requiresFiscal: true });

    expect(updateData()).toEqual({ requiresFiscal: true });
  });

  it.each([
    [
      'каса при типі «банківський рахунок»',
      { defaultSourceType: 'BANK_ACCOUNT' as const, defaultCashRegisterId: CASH_ID },
    ],
    [
      'рахунок при типі «каса»',
      {
        defaultSourceType: 'CASH_REGISTER' as const,
        defaultCashRegisterId: CASH_ID,
        defaultBankAccountId: BANK_ID,
      },
    ],
    ['каса при знятому призначенні', { defaultSourceType: null, defaultCashRegisterId: CASH_ID }],
    [
      'каса й рахунок разом без типу',
      { defaultCashRegisterId: CASH_ID, defaultBankAccountId: BANK_ID },
    ],
  ])('неузгоджені тип і id (%s) → 400, нічого не пишеться', async (_label, dto) => {
    await expect(service.update(ORG, PM_ID, dto)).rejects.toThrow(
      new BadRequestException(
        'Касу вказують лише для надходження в касу, банківський рахунок — лише для надходження на рахунок',
      ),
    );
    expect(prisma.paymentMethodConfig.update).not.toHaveBeenCalled();
  });

  it.each([
    ['каса', { defaultSourceType: 'CASH_REGISTER' as const }, 'Не вказано касу'],
    [
      'банківський рахунок',
      { defaultSourceType: 'BANK_ACCOUNT' as const },
      'Не вказано банківський рахунок',
    ],
  ])('тип «%s» без id → 400', async (_label, dto, message) => {
    await expect(service.update(ORG, PM_ID, dto)).rejects.toThrow(new BadRequestException(message));
    expect(prisma.paymentMethodConfig.update).not.toHaveBeenCalled();
  });

  it('каса чужої організації або видалена → 404, нічого не пишеться', async () => {
    prisma.cashRegister.findFirst.mockResolvedValue(null);

    await expect(
      service.update(ORG, PM_ID, {
        defaultSourceType: 'CASH_REGISTER',
        defaultCashRegisterId: CASH_ID,
      }),
    ).rejects.toThrow(new NotFoundException('Касу не знайдено'));
    expect(prisma.paymentMethodConfig.update).not.toHaveBeenCalled();
  });

  it('банківський рахунок чужої організації або видалений → 404, нічого не пишеться', async () => {
    prisma.bankAccount.findFirst.mockResolvedValue(null);

    await expect(
      service.update(ORG, PM_ID, {
        defaultSourceType: 'BANK_ACCOUNT',
        defaultBankAccountId: BANK_ID,
      }),
    ).rejects.toThrow(new NotFoundException('Банківський рахунок не знайдено'));
    expect(prisma.paymentMethodConfig.update).not.toHaveBeenCalled();
  });

  it('create зі способом і касою за замовчуванням пише призначення разом зі способом', async () => {
    prisma.paymentMethodConfig.findFirst.mockResolvedValue(null);

    const res = await service.create(ORG, {
      code: 'cash_safe',
      name: 'Готівка (сейф)',
      defaultSourceType: 'CASH_REGISTER',
      defaultCashRegisterId: CASH_ID,
    });

    expect(prisma.paymentMethodConfig.create).toHaveBeenCalledWith({
      data: {
        code: 'cash_safe',
        name: 'Готівка (сейф)',
        defaultSourceType: 'CASH_REGISTER',
        defaultCashRegisterId: CASH_ID,
        defaultBankAccountId: null,
        orgId: ORG,
      },
    });
    expect(res.defaultDestinationName).toBe('Каса 1');
  });

  it('create з чужою касою → 404 до запису', async () => {
    prisma.paymentMethodConfig.findFirst.mockResolvedValue(null);
    prisma.cashRegister.findFirst.mockResolvedValue(null);

    await expect(
      service.create(ORG, {
        code: 'cash_safe',
        name: 'Готівка (сейф)',
        defaultCashRegisterId: CASH_ID,
      }),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.paymentMethodConfig.create).not.toHaveBeenCalled();
  });

  it('список: назви кас і рахунків двома запитами на весь список, лише живі й своєї організації', async () => {
    prisma.paymentMethodConfig.findMany.mockResolvedValue([
      row({ defaultSourceType: 'CASH_REGISTER', defaultCashRegisterId: CASH_ID }),
      row({
        id: 'pm-card',
        code: 'card',
        defaultSourceType: 'BANK_ACCOUNT',
        defaultBankAccountId: BANK_ID,
      }),
      row({ id: 'pm-terminal', code: 'card_terminal' }),
      // Касу видалено після налаштування: назви немає — призначення фактично немає.
      row({
        id: 'pm-old',
        code: 'old',
        defaultSourceType: 'CASH_REGISTER',
        defaultCashRegisterId: '99999999-9999-4999-8999-999999999999',
      }),
    ]);

    const list = await service.findAll(ORG);

    expect(list.map(m => m.defaultDestinationName)).toEqual(['Каса 1', 'ПриватБанк', null, null]);
    expect(prisma.cashRegister.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.bankAccount.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.cashRegister.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: [CASH_ID, '99999999-9999-4999-8999-999999999999'] },
          orgId: ORG,
          deletedAt: null,
        },
      }),
    );
    expect(prisma.bankAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [BANK_ID] }, orgId: ORG, deletedAt: null } }),
    );
  });

  it('список із кешу: назву все одно читаємо свіжу (касу могли перейменувати)', async () => {
    cache.get.mockResolvedValue([
      {
        id: PM_ID,
        orgId: ORG,
        code: 'cash',
        name: 'Готівка',
        isActive: true,
        isSystem: true,
        sortOrder: 1,
        requiresFiscal: false,
        defaultSourceType: 'CASH_REGISTER',
        defaultCashRegisterId: CASH_ID,
        defaultBankAccountId: null,
        updatedAt: '2026-10-14T10:00:00.000Z',
      },
    ]);
    prisma.cashRegister.findMany.mockResolvedValue([{ id: CASH_ID, name: 'Каса нова назва' }]);

    const list = await service.findAll(ORG);

    expect(prisma.paymentMethodConfig.findMany).not.toHaveBeenCalled();
    expect(list[0].defaultDestinationName).toBe('Каса нова назва');
  });
});
