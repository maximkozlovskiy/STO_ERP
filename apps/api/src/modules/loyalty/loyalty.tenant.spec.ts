import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import { LoyaltyService } from './loyalty.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Tenant isolation лояльності (BR-LOY-012, BR-LOY-013).
 *
 * Два незалежні бар'єри, і кожен стережеться окремо:
 *   • контрагент шукається за { id, orgId, deletedAt: null } — чужий або видалений → NotFound;
 *   • LoyaltyAccount читається з orgId у where — рахунок чужої організації не повертається,
 *     навіть якщо counterpartyId вгадано.
 */
describe('LoyaltyService — tenant isolation', () => {
  let service: LoyaltyService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  const orgId = 'org-1';
  const counterpartyId = 'cp-1';
  const accountId = 'acc-1';
  const counterpartyWhere = { id: counterpartyId, orgId, deletedAt: null };
  const accountWhere = { counterpartyId, orgId };

  beforeEach(async () => {
    prisma = {
      counterparty: { findFirst: vi.fn().mockResolvedValue({ id: counterpartyId }) },
      organisationSettings: {
        findFirst: vi.fn().mockResolvedValue({
          loyaltyEnabled: true,
          loyaltyEarnPer: 100,
          loyaltyEarnPoints: 1,
          loyaltyRedeemRate: 1,
        }),
      },
      loyaltyAccount: {
        findFirst: vi.fn().mockResolvedValue({ id: accountId, balance: 25 }),
        upsert: vi.fn().mockResolvedValue({ id: accountId, balance: 0 }),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      loyaltyTransaction: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn(),
      },
      $transaction: vi.fn(async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma)),
    };
    const module = await Test.createTestingModule({
      providers: [
        LoyaltyService,
        { provide: PrismaService, useValue: prisma },
        { provide: getQueueToken('loyalty'), useValue: { add: vi.fn() } },
      ],
    }).compile();
    service = module.get(LoyaltyService);
  });

  describe('контрагент: { id, orgId, deletedAt: null }', () => {
    // guards: BR-LOY-012
    it('getBalance шукає контрагента у своїй організації серед невидалених', async () => {
      await service.getBalance(orgId, counterpartyId);
      expect(prisma.counterparty.findFirst.mock.calls[0][0].where).toEqual(counterpartyWhere);
    });

    // guards: BR-LOY-012
    it('getTransactions шукає контрагента у своїй організації серед невидалених', async () => {
      await service.getTransactions(orgId, counterpartyId);
      expect(prisma.counterparty.findFirst.mock.calls[0][0].where).toEqual(counterpartyWhere);
    });

    // guards: BR-LOY-012
    it('redeem шукає контрагента у своїй організації серед невидалених', async () => {
      await service.redeem(orgId, counterpartyId, 10);
      expect(prisma.counterparty.findFirst.mock.calls[0][0].where).toEqual(counterpartyWhere);
    });

    // guards: BR-LOY-012
    it('earn шукає контрагента у своїй організації серед невидалених', async () => {
      await service.earn(orgId, counterpartyId, 1000, 'pay-1');
      expect(prisma.counterparty.findFirst.mock.calls[0][0].where).toEqual(counterpartyWhere);
    });

    // guards: BR-LOY-012
    it('getOrCreateAccount шукає контрагента у своїй організації серед невидалених', async () => {
      await service.getOrCreateAccount(orgId, counterpartyId);
      expect(prisma.counterparty.findFirst.mock.calls[0][0].where).toEqual(counterpartyWhere);
    });
  });

  describe('контрагент чужий або видалений → NotFound, запису немає', () => {
    beforeEach(() => {
      prisma.counterparty.findFirst.mockResolvedValue(null);
    });

    // guards: BR-LOY-012
    it('getBalance → NotFoundException (баланс чужого рахунку не віддається)', async () => {
      await expect(service.getBalance(orgId, counterpartyId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    // guards: BR-LOY-012
    it('getTransactions → NotFoundException, леджер не читається', async () => {
      await expect(service.getTransactions(orgId, counterpartyId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.loyaltyTransaction.findMany).not.toHaveBeenCalled();
    });

    // guards: BR-LOY-012
    it('earn → NotFoundException, рахунок не створюється і бали не нараховуються', async () => {
      await expect(service.earn(orgId, counterpartyId, 1000, 'pay-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.loyaltyAccount.upsert).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    // guards: BR-LOY-012
    it('getOrCreateAccount → NotFoundException, upsert не викликається', async () => {
      await expect(service.getOrCreateAccount(orgId, counterpartyId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.loyaltyAccount.upsert).not.toHaveBeenCalled();
    });
  });

  describe('LoyaltyAccount читається з orgId', () => {
    // guards: BR-LOY-013
    it('getBalance: loyaltyAccount.findFirst where { counterpartyId, orgId }', async () => {
      const result = await service.getBalance(orgId, counterpartyId);
      expect(prisma.loyaltyAccount.findFirst.mock.calls[0][0].where).toEqual(accountWhere);
      expect(result).toEqual({ balance: 25, counterpartyId });
    });

    // guards: BR-LOY-013
    it('getTransactions: loyaltyAccount.findFirst where { counterpartyId, orgId }', async () => {
      await service.getTransactions(orgId, counterpartyId);
      expect(prisma.loyaltyAccount.findFirst.mock.calls[0][0].where).toEqual(accountWhere);
    });

    // guards: BR-LOY-013
    it('redeem: рахунок шукається з orgId, і decrement теж обмежений orgId', async () => {
      await service.redeem(orgId, counterpartyId, 10);
      expect(prisma.loyaltyAccount.findFirst.mock.calls[0][0].where).toEqual(accountWhere);
      expect(prisma.loyaltyAccount.updateMany.mock.calls[0][0].where).toEqual({
        id: accountId,
        orgId,
        balance: { gte: 10 },
      });
    });

    it('getBalance: рахунку в цій організації немає → баланс 0, а не чужий', async () => {
      prisma.loyaltyAccount.findFirst.mockResolvedValue(null);
      await expect(service.getBalance(orgId, counterpartyId)).resolves.toEqual({
        balance: 0,
        counterpartyId,
      });
    });
  });
});
