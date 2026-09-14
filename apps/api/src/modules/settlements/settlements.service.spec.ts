import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { SettlementsService } from './settlements.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ExchangeRatesService } from '../exchange-rates/exchange-rates.service';

describe('SettlementsService.createTransaction', () => {
  let service: SettlementsService;
  let prisma: {
    settlementAccount: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    settlementTransaction: { create: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let exchangeRates: { resolveBaseConversion: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    prisma = {
      settlementAccount: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
      settlementTransaction: {
        create: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    };
    // Дефолт: базова валюта (rate=1, amountBase=amount) — 7 UAH-викликачів не передають currencyId.
    exchangeRates = {
      resolveBaseConversion: vi
        .fn()
        .mockImplementation(async (_org: string, _cur: string, _date: Date, amount: number) => ({
          rateUsed: 1,
          amountBase: amount,
        })),
    };
    const module = await Test.createTestingModule({
      providers: [
        SettlementsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ExchangeRatesService, useValue: exchangeRates },
      ],
    }).compile();
    service = module.get(SettlementsService);
  });

  const dto = (
    overrides: Partial<Parameters<SettlementsService['createTransaction']>[1]> = {},
  ) => ({
    counterpartyId: 'cp-1',
    type: 'CHARGE' as const,
    amount: 100,
    ...overrides,
  });

  it('кидає BadRequestException при amount = 0', async () => {
    await expect(service.createTransaction('org-1', dto({ amount: 0 }))).rejects.toThrow(
      BadRequestException,
    );
  });

  it('кидає BadRequestException при amount < 0', async () => {
    await expect(service.createTransaction('org-1', dto({ amount: -50 }))).rejects.toThrow(
      BadRequestException,
    );
  });

  it('кидає BadRequestException при amount = NaN', async () => {
    await expect(service.createTransaction('org-1', dto({ amount: NaN }))).rejects.toThrow(
      BadRequestException,
    );
  });

  it('кидає NotFoundException якщо немає SettlementAccount', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue(null);
    await expect(service.createTransaction('org-1', dto())).rejects.toThrow(NotFoundException);
  });

  it('CHARGE інкрементує balance на +amount', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
    await service.createTransaction('org-1', dto({ type: 'CHARGE', amount: 100 }));
    expect(prisma.settlementAccount.update).toHaveBeenCalledWith({
      where: { id: 'acc-1', orgId: 'org-1' },
      data: { balance: { increment: 100 } },
    });
  });

  it('PAYMENT декрементує balance на -amount', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
    await service.createTransaction('org-1', dto({ type: 'PAYMENT', amount: 100 }));
    expect(prisma.settlementAccount.update).toHaveBeenCalledWith({
      where: { id: 'acc-1', orgId: 'org-1' },
      data: { balance: { increment: -100 } },
    });
  });

  it.each(['PREPAYMENT', 'REFUND', 'CREDIT_NOTE'] as const)(
    '%s декрементує balance на -amount',
    async type => {
      prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
      await service.createTransaction('org-1', dto({ type, amount: 50 }));
      expect(prisma.settlementAccount.update).toHaveBeenCalledWith({
        where: { id: 'acc-1', orgId: 'org-1' },
        data: { balance: { increment: -50 } },
      });
    },
  );

  // Постачальницькі типи — окрема семантика знаку (fix знаку балансу постачальника):
  // отримали товар (SUPPLIER_CHARGE) → ми винні (balance↓); заплатили/повернули → borg↑.
  it('SUPPLIER_CHARGE декрементує balance на -amount (ми винні постачальнику)', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
    await service.createTransaction('org-1', dto({ type: 'SUPPLIER_CHARGE', amount: 100 }));
    expect(prisma.settlementAccount.update).toHaveBeenCalledWith({
      where: { id: 'acc-1', orgId: 'org-1' },
      data: { balance: { increment: -100 } },
    });
  });

  it.each(['SUPPLIER_PAYMENT', 'SUPPLIER_REFUND'] as const)(
    '%s інкрементує balance на +amount (наш борг постачальнику меншає)',
    async type => {
      prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
      await service.createTransaction('org-1', dto({ type, amount: 100 }));
      expect(prisma.settlementAccount.update).toHaveBeenCalledWith({
        where: { id: 'acc-1', orgId: 'org-1' },
        data: { balance: { increment: 100 } },
      });
    },
  );

  it('створює settlementTransaction з усіма полями', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
    await service.createTransaction(
      'org-1',
      dto({
        type: 'CHARGE',
        amount: 100,
        documentType: 'WorkOrder',
        documentId: 'wo-1',
        createdBy: 'emp-1',
        notes: 'test',
      }),
    );
    expect(prisma.settlementTransaction.create).toHaveBeenCalledWith({
      data: {
        orgId: 'org-1',
        settlementAccountId: 'acc-1',
        type: 'CHARGE',
        amount: 100,
        // Без currencyId → базова (rate=1, amountBase=amount) — BC для UAH-викликачів.
        currencyId: null,
        amountBase: 100,
        rateUsed: 1,
        documentType: 'WorkOrder',
        documentId: 'wo-1',
        notes: 'test',
        createdBy: 'emp-1',
      },
    });
  });

  // ── Мультивалюта (Фаза 2) ──────────────────────────────────────────────────
  it('без currencyId → base (rate=1, amountBase=amount), resolveBaseConversion не викликається', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
    await service.createTransaction('org-1', dto({ type: 'CHARGE', amount: 250 }));
    expect(exchangeRates.resolveBaseConversion).not.toHaveBeenCalled();
    expect(prisma.settlementAccount.update).toHaveBeenCalledWith({
      where: { id: 'acc-1', orgId: 'org-1' },
      data: { balance: { increment: 250 } },
    });
  });

  it('з currencyId (USD) → balanceDelta від amountBase, не від amount', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
    // 100 USD × курс 41.50 = 4150 UAH base
    exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 41.5, amountBase: 4150 });
    await service.createTransaction(
      'org-1',
      dto({ type: 'PAYMENT', amount: 100, currencyId: 'usd-1' }),
    );
    expect(exchangeRates.resolveBaseConversion).toHaveBeenCalledWith(
      'org-1',
      'usd-1',
      expect.any(Date),
      100,
      false,
    );
    // PAYMENT = -1 → balance -= amountBase (4150), НЕ -100
    expect(prisma.settlementAccount.update).toHaveBeenCalledWith({
      where: { id: 'acc-1', orgId: 'org-1' },
      data: { balance: { increment: -4150 } },
    });
    expect(prisma.settlementTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amount: 100,
        currencyId: 'usd-1',
        amountBase: 4150,
        rateUsed: 41.5,
      }),
    });
  });

  // Фаза 3: документні потоки передають date (дата події) + fallbackToLatest у resolveBaseConversion.
  it('пробрасує date + fallbackToLatest у resolveBaseConversion (документний потік)', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
    exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 41.5, amountBase: 4150 });
    const docDate = new Date('2026-01-01');
    await service.createTransaction(
      'org-1',
      dto({
        type: 'CHARGE',
        amount: 100,
        currencyId: 'usd-1',
        date: docDate,
        fallbackToLatest: true,
      }),
    );
    expect(exchangeRates.resolveBaseConversion).toHaveBeenCalledWith(
      'org-1',
      'usd-1',
      docDate,
      100,
      true,
    );
  });

  it('без date → new Date(); без fallbackToLatest → false (BC для Фази 2)', async () => {
    prisma.settlementAccount.findFirst.mockResolvedValue({ id: 'acc-1' });
    exchangeRates.resolveBaseConversion.mockResolvedValue({ rateUsed: 41.5, amountBase: 4150 });
    await service.createTransaction(
      'org-1',
      dto({ type: 'PAYMENT', amount: 100, currencyId: 'usd-1' }),
    );
    expect(exchangeRates.resolveBaseConversion).toHaveBeenCalledWith(
      'org-1',
      'usd-1',
      expect.any(Date),
      100,
      false,
    );
  });
});
