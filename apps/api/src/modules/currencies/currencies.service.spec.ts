import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CurrenciesService } from './currencies.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';

describe('CurrenciesService.create', () => {
  let service: CurrenciesService;
  let prisma: {
    currency: {
      findFirst: ReturnType<typeof vi.fn>;
      findFirstOrThrow: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
  };
  let cache: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    delPattern: ReturnType<typeof vi.fn>;
  };

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'c-1',
    orgId: 'org-1',
    name: 'Долар',
    fullName: null,
    internationalName: null,
    code: 'USD',
    symbol: '$',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

  beforeEach(async () => {
    cache = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      del: vi.fn().mockResolvedValue(undefined),
      delPattern: vi.fn().mockResolvedValue(undefined),
    };
    prisma = {
      currency: {
        findFirst: vi.fn(),
        findFirstOrThrow: vi.fn().mockResolvedValue(row()),
        create: vi.fn().mockResolvedValue(row()),
        update: vi.fn().mockResolvedValue(row()),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        CurrenciesService,
        { provide: PrismaService, useValue: prisma },
        { provide: CacheService, useValue: cache },
      ],
    }).compile();
    service = module.get(CurrenciesService);
  });

  it('кидає ConflictException на активний дубль коду', async () => {
    prisma.currency.findFirst.mockResolvedValueOnce(row()); // active duplicate
    await expect(service.create('org-1', { name: 'Долар', code: 'USD' })).rejects.toThrow(
      ConflictException,
    );
    expect(prisma.currency.create).not.toHaveBeenCalled();
  });

  // Bug #152: повний unique (orgId, code) включає soft-deleted → воскрешаємо.
  // Сервіс робить ОДИН findFirst (fetch any row), потім branch на deletedAt.
  it('воскрешає soft-deleted валюту замість create (Bug #152)', async () => {
    prisma.currency.findFirst.mockResolvedValueOnce(
      row({ id: 'c-deleted', deletedAt: new Date() }),
    ); // soft-deleted row occupies unique key
    await service.create('org-1', { name: 'Долар США', code: 'USD' });
    expect(prisma.currency.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'c-deleted', orgId: 'org-1' },
        data: expect.objectContaining({ deletedAt: null }),
      }),
    );
    expect(prisma.currency.create).not.toHaveBeenCalled();
  });

  it('створює нову валюту коли немає ні активної, ні видаленої', async () => {
    prisma.currency.findFirst.mockResolvedValueOnce(null); // no row at all
    await service.create('org-1', { name: 'Долар', code: 'USD' });
    expect(prisma.currency.create).toHaveBeenCalledTimes(1);
  });

  // isSystem-guard (audit round 3 gap): базову валюту (UAH) не можна видалити/перейменувати.
  describe('remove/update — isSystem guard', () => {
    it('remove системної валюти → BadRequestException, без soft-delete', async () => {
      prisma.currency.findFirst.mockResolvedValueOnce({ isSystem: true });
      await expect(service.remove('org-1', 'c-uah')).rejects.toThrow(BadRequestException);
      expect(prisma.currency.updateMany).not.toHaveBeenCalled();
    });

    it('remove звичайної валюти → soft-delete', async () => {
      prisma.currency.findFirst.mockResolvedValueOnce({ isSystem: false });
      await service.remove('org-1', 'c-usd');
      expect(prisma.currency.updateMany).toHaveBeenCalledTimes(1);
    });

    it('update code/name системної валюти → BadRequestException', async () => {
      prisma.currency.findFirst
        .mockResolvedValueOnce({ code: 'UAH', isSystem: true }) // existing
        .mockResolvedValueOnce(null); // duplicate-check
      await expect(service.update('org-1', 'c-uah', { name: 'Інша' })).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.currency.updateMany).not.toHaveBeenCalled();
    });

    it('update NBU-налаштувань системної валюти → дозволено', async () => {
      prisma.currency.findFirst
        .mockResolvedValueOnce({ code: 'UAH', isSystem: true }) // existing
        .mockResolvedValueOnce(null); // duplicate-check (no code in dto)
      await service.update('org-1', 'c-uah', { nbuFetchEnabled: true });
      expect(prisma.currency.updateMany).toHaveBeenCalledTimes(1);
    });
  });
});
