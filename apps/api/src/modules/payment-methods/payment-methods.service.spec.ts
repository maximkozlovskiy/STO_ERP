import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PaymentMethodsService } from './payment-methods.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';

/**
 * isSystem-guard (audit round 3 gap): системні методи оплати (Готівка/Картка/…) не можна
 * видаляти чи перейменовувати через API. Дзеркалить units/currencies isSystem-guard.
 */
describe('PaymentMethodsService — isSystem guard', () => {
  let service: PaymentMethodsService;
  let prisma: {
    paymentMethodConfig: {
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
  };
  let cache: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    cache = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      del: vi.fn().mockResolvedValue(undefined),
    };
    prisma = {
      paymentMethodConfig: {
        findFirst: vi.fn(),
        update: vi.fn().mockResolvedValue({
          id: 'pm-1',
          orgId: 'org-1',
          code: 'cash',
          name: 'Готівка',
          isActive: true,
          isSystem: true,
          sortOrder: 1,
          requiresFiscal: true,
          updatedAt: new Date(),
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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

  it('remove системного методу → BadRequestException, без soft-delete', async () => {
    prisma.paymentMethodConfig.findFirst.mockResolvedValueOnce({ isSystem: true });
    await expect(service.remove('org-1', 'pm-cash')).rejects.toThrow(BadRequestException);
    expect(prisma.paymentMethodConfig.updateMany).not.toHaveBeenCalled();
  });

  it('remove звичайного методу → soft-delete', async () => {
    prisma.paymentMethodConfig.findFirst.mockResolvedValueOnce({ isSystem: false });
    await service.remove('org-1', 'pm-custom');
    expect(prisma.paymentMethodConfig.updateMany).toHaveBeenCalledTimes(1);
  });

  it('remove неіснуючого → NotFoundException', async () => {
    prisma.paymentMethodConfig.findFirst.mockResolvedValueOnce(null);
    await expect(service.remove('org-1', 'missing')).rejects.toThrow(NotFoundException);
  });

  it('update name системного методу → BadRequestException', async () => {
    prisma.paymentMethodConfig.findFirst.mockResolvedValueOnce({ id: 'pm-1', isSystem: true });
    await expect(service.update('org-1', 'pm-cash', { name: 'Інша назва' })).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.paymentMethodConfig.update).not.toHaveBeenCalled();
  });

  it('update isActive/sortOrder системного методу → дозволено (косметика per-org)', async () => {
    prisma.paymentMethodConfig.findFirst.mockResolvedValueOnce({ id: 'pm-1', isSystem: true });
    await service.update('org-1', 'pm-cash', { isActive: false });
    expect(prisma.paymentMethodConfig.update).toHaveBeenCalledTimes(1);
  });
});
