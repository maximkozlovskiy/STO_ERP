import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CurrenciesService } from './currencies.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';

describe('CurrenciesService.create', () => {
  let service: CurrenciesService;
  let prisma: {
    currency: {
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
  let cache: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn>; delPattern: ReturnType<typeof vi.fn> };

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'c-1', orgId: 'org-1', name: 'Долар', fullName: null, internationalName: null,
    code: 'USD', symbol: '$', createdAt: new Date(), updatedAt: new Date(),
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
        create: vi.fn().mockResolvedValue(row()),
        update: vi.fn().mockResolvedValue(row()),
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
    await expect(service.create('org-1', { name: 'Долар', code: 'USD' }))
      .rejects.toThrow(ConflictException);
    expect(prisma.currency.create).not.toHaveBeenCalled();
  });

  // Bug #152: повний unique (orgId, code) включає soft-deleted → воскрешаємо.
  // Сервіс робить ОДИН findFirst (fetch any row), потім branch на deletedAt.
  it('воскрешає soft-deleted валюту замість create (Bug #152)', async () => {
    prisma.currency.findFirst.mockResolvedValueOnce(row({ id: 'c-deleted', deletedAt: new Date() })); // soft-deleted row occupies unique key
    await service.create('org-1', { name: 'Долар США', code: 'USD' });
    expect(prisma.currency.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'c-deleted' },
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
});
