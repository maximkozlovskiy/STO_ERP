import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { LoyaltyService } from './loyalty.service';
import { PrismaService } from '../../prisma/prisma.service';
import { getQueueToken } from '@nestjs/bull';

/**
 * Bug #254: unit-покриття `LoyaltyService.redeem`.
 *
 * Фокус — atomic check-and-decrement у `redeem`:
 *   • `updateMany({ where: { id, balance: { gte: points } } })` — атомарний guard
 *   • `count === 0` → `BadRequestException('Недостатньо балів')`
 *
 * Без spec будь-який refactor що замінить `gte` на `gt`, або зробить read+write
 * без атомарної умови, відкриє double-spend race у проді (двоє паралельних
 * redeem-запитів обидва побачать достатньо балансу, обидва списать).
 */
describe('LoyaltyService.redeem', () => {
  let service: LoyaltyService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  const orgId = 'org-1';
  const counterpartyId = 'cp-1';
  const accountId = 'acc-1';

  beforeEach(async () => {
    prisma = {
      counterparty: { findFirst: vi.fn() },
      organisationSettings: { findFirst: vi.fn() },
      loyaltyAccount: {
        findFirst: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn(),
      },
      loyaltyTransaction: {
        create: vi.fn(),
      },
      $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma)),
    };
    const loyaltyQueueMock = { add: vi.fn() };
    const module = await Test.createTestingModule({
      providers: [
        LoyaltyService,
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken('loyalty'), useValue: loyaltyQueueMock },
      ],
    }).compile();
    service = module.get(LoyaltyService);
  });

  it('happy path: атомарний updateMany з balance: { gte: points }, потім LoyaltyTransaction', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: counterpartyId });
    prisma.organisationSettings.findFirst.mockResolvedValueOnce({ loyaltyRedeemRate: 1 });
    prisma.loyaltyAccount.findFirst.mockResolvedValueOnce({ id: accountId });
    prisma.loyaltyAccount.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.loyaltyTransaction.create.mockResolvedValueOnce({ id: 'tx-1' });

    const result = await service.redeem(orgId, counterpartyId, 50);

    // Bug #254: критичний guard — `updateMany` з `balance: { gte: points }`.
    // Регресія `gte` → `gt` блокує точне витрачання, регресія зняття guard взагалі
    // дозволяє double-spend → CI має це ловити.
    expect(prisma.loyaltyAccount.updateMany).toHaveBeenCalledTimes(1);
    const updateArgs = prisma.loyaltyAccount.updateMany.mock.calls[0][0];
    expect(updateArgs.where.id).toBe(accountId);
    expect(updateArgs.where.balance).toEqual({ gte: 50 });
    expect(updateArgs.data.balance).toEqual({ decrement: 50 });

    // НЕ викликати простий update — щоб refactor назад до неатомарного шляху провалив тест.
    expect(prisma.loyaltyAccount.update).not.toHaveBeenCalled();

    // LoyaltyTransaction (REDEEM) має бути створена з правильним accountId.
    expect(prisma.loyaltyTransaction.create).toHaveBeenCalledTimes(1);
    const txArgs = prisma.loyaltyTransaction.create.mock.calls[0][0];
    expect(txArgs.data.accountId).toBe(accountId);
    expect(txArgs.data.type).toBe('REDEEM');
    expect(txArgs.data.points).toBe(50);

    expect(result.discountAmount).toBe(50);
  });

  it('недостатньо балів: updateMany.count === 0 → BadRequestException', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: counterpartyId });
    prisma.organisationSettings.findFirst.mockResolvedValueOnce({ loyaltyRedeemRate: 1 });
    prisma.loyaltyAccount.findFirst.mockResolvedValueOnce({ id: accountId });
    // Critical: count=0 моделює реальний випадок коли BD виявила недостатньо балансу
    prisma.loyaltyAccount.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.redeem(orgId, counterpartyId, 5000)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // LoyaltyTransaction НЕ створюється коли guard зафейлив.
    expect(prisma.loyaltyTransaction.create).not.toHaveBeenCalled();
  });

  it('контрагент відсутній → NotFoundException, $transaction не викликаний', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce(null);
    prisma.organisationSettings.findFirst.mockResolvedValueOnce({ loyaltyRedeemRate: 1 });

    await expect(service.redeem(orgId, counterpartyId, 50)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('обліковий запис лояльності відсутній → NotFoundException("Рахунок лояльності не знайдено")', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: counterpartyId });
    prisma.organisationSettings.findFirst.mockResolvedValueOnce({ loyaltyRedeemRate: 1 });
    prisma.loyaltyAccount.findFirst.mockResolvedValueOnce(null);

    await expect(service.redeem(orgId, counterpartyId, 50)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(prisma.loyaltyAccount.updateMany).not.toHaveBeenCalled();
    expect(prisma.loyaltyTransaction.create).not.toHaveBeenCalled();
  });

  it('points <= 0 → BadRequestException ("Кількість балів має бути > 0")', async () => {
    await expect(service.redeem(orgId, counterpartyId, 0)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.redeem(orgId, counterpartyId, -5)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // Жодного prisma-виклику до самого ранього guard.
    expect(prisma.counterparty.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('redeemRate з налаштувань впливає на discountAmount', async () => {
    prisma.counterparty.findFirst.mockResolvedValueOnce({ id: counterpartyId });
    // 1 бал = 2 грн знижки
    prisma.organisationSettings.findFirst.mockResolvedValueOnce({ loyaltyRedeemRate: 2 });
    prisma.loyaltyAccount.findFirst.mockResolvedValueOnce({ id: accountId });
    prisma.loyaltyAccount.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.loyaltyTransaction.create.mockResolvedValueOnce({ id: 'tx-1' });

    const result = await service.redeem(orgId, counterpartyId, 50);

    expect(result.discountAmount).toBe(100); // 50 балів × 2 грн
  });
});

describe('LoyaltyService.earn', () => {
  let service: LoyaltyService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  const orgId = 'org-1';
  const counterpartyId = 'cp-1';

  beforeEach(async () => {
    prisma = {
      counterparty: { findFirst: vi.fn() },
      organisationSettings: { findFirst: vi.fn() },
      loyaltyAccount: {
        upsert: vi.fn().mockResolvedValue({ id: 'acc-1', balance: 0 }),
        update: vi.fn(),
      },
      loyaltyTransaction: {
        create: vi.fn(),
      },
      $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma)),
    };
    const loyaltyQueueMock = { add: vi.fn() };
    const module = await Test.createTestingModule({
      providers: [
        LoyaltyService,
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken('loyalty'), useValue: loyaltyQueueMock },
      ],
    }).compile();
    service = module.get(LoyaltyService);
  });

  it('Bug #271: paymentAmount=NaN → ранній return без doторкання $transaction', async () => {
    await service.earn(orgId, counterpartyId, Number.NaN);
    expect(prisma.organisationSettings.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.loyaltyTransaction.create).not.toHaveBeenCalled();
  });

  it('Bug #271: paymentAmount=Infinity → ранній return без $transaction', async () => {
    await service.earn(orgId, counterpartyId, Number.POSITIVE_INFINITY);
    expect(prisma.organisationSettings.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('Bug #271: paymentAmount=0 → ранній return без $transaction', async () => {
    await service.earn(orgId, counterpartyId, 0);
    expect(prisma.organisationSettings.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('loyaltyEnabled=false → ранній return після перевірки settings', async () => {
    prisma.organisationSettings.findFirst.mockResolvedValueOnce({ loyaltyEnabled: false });
    await service.earn(orgId, counterpartyId, 1000);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.loyaltyTransaction.create).not.toHaveBeenCalled();
  });

  it('happy path: paymentAmount=1000, earnPer=100, earnPoints=1 → +10 points', async () => {
    prisma.counterparty.findFirst.mockResolvedValue({ id: counterpartyId });
    prisma.organisationSettings.findFirst.mockResolvedValueOnce({
      loyaltyEnabled: true,
      loyaltyEarnPer: 100,
      loyaltyEarnPoints: 1,
    });
    await service.earn(orgId, counterpartyId, 1000);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.loyaltyAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { balance: { increment: 10 } },
      }),
    );
    expect(prisma.loyaltyTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'EARN', points: 10 }),
      }),
    );
  });
});
