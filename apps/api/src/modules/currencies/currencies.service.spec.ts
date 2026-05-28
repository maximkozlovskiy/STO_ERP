import { Test } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CurrenciesService } from './currencies.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('CurrenciesService.create', () => {
  let service: CurrenciesService;
  let prisma: {
    currency: {
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'c-1', orgId: 'org-1', name: 'Долар', fullName: null, internationalName: null,
    code: 'USD', symbol: '$', createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      currency: {
        findFirst: vi.fn(),
        create: vi.fn().mockResolvedValue(row()),
        update: vi.fn().mockResolvedValue(row()),
      },
    };
    const module = await Test.createTestingModule({
      providers: [CurrenciesService, { provide: PrismaService, useValue: prisma }],
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
  it('воскрешає soft-deleted валюту замість create (Bug #152)', async () => {
    prisma.currency.findFirst
      .mockResolvedValueOnce(null) // no active duplicate
      .mockResolvedValueOnce(row({ id: 'c-deleted', deletedAt: new Date() })); // soft-deleted
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
    prisma.currency.findFirst
      .mockResolvedValueOnce(null) // no active
      .mockResolvedValueOnce(null); // no soft-deleted
    await service.create('org-1', { name: 'Долар', code: 'USD' });
    expect(prisma.currency.create).toHaveBeenCalledTimes(1);
  });
});
