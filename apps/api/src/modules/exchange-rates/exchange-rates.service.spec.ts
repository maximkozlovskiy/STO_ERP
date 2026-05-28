import { Test } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ExchangeRatesService } from './exchange-rates.service';
import { PrismaService } from '../../prisma/prisma.service';

const CURRENCY_ID = '11111111-1111-4111-8111-111111111111';

describe('ExchangeRatesService', () => {
  let service: ExchangeRatesService;
  let prisma: {
    currency: { findFirst: ReturnType<typeof vi.fn> };
    exchangeRate: {
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };

  const fullRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'er-1', orgId: 'org-1', currencyId: CURRENCY_ID,
    date: new Date('2026-05-28'), rate: 41.5, coefficient: 1,
    createdAt: new Date(), updatedAt: new Date(),
    currency: { code: 'USD', name: 'Долар' },
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      currency: { findFirst: vi.fn() },
      exchangeRate: {
        findFirst: vi.fn(),
        create: vi.fn().mockResolvedValue(fullRow()),
        update: vi.fn().mockResolvedValue(fullRow()),
      },
    };
    const module = await Test.createTestingModule({
      providers: [ExchangeRatesService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(ExchangeRatesService);
  });

  describe('create', () => {
    it('кидає ConflictException на активний дубль (orgId, currencyId, date)', async () => {
      prisma.currency.findFirst.mockResolvedValueOnce({ id: CURRENCY_ID });
      prisma.exchangeRate.findFirst.mockResolvedValueOnce(fullRow()); // active duplicate
      await expect(
        service.create('org-1', { currencyId: CURRENCY_ID, date: '2026-05-28', rate: 41.5 }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.exchangeRate.create).not.toHaveBeenCalled();
    });

    // Bug #152: повний unique index включає soft-deleted рядок → воскрешаємо, не create.
    // Сервіс робить ОДИН exchangeRate.findFirst (fetch any row), потім branch на deletedAt.
    it('воскрешає soft-deleted курс замість create (Bug #152)', async () => {
      prisma.currency.findFirst.mockResolvedValueOnce({ id: CURRENCY_ID });
      prisma.exchangeRate.findFirst.mockResolvedValueOnce(fullRow({ id: 'er-deleted', deletedAt: new Date() })); // soft-deleted row occupies unique key
      await service.create('org-1', { currencyId: CURRENCY_ID, date: '2026-05-28', rate: 42 });
      expect(prisma.exchangeRate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'er-deleted' },
          data: expect.objectContaining({ deletedAt: null }),
        }),
      );
      expect(prisma.exchangeRate.create).not.toHaveBeenCalled();
    });

    it('створює новий курс коли немає ні активного, ні видаленого', async () => {
      prisma.currency.findFirst.mockResolvedValueOnce({ id: CURRENCY_ID });
      prisma.exchangeRate.findFirst.mockResolvedValueOnce(null); // no row at all
      await service.create('org-1', { currencyId: CURRENCY_ID, date: '2026-05-28', rate: 41.5 });
      expect(prisma.exchangeRate.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('update', () => {
    // Bug #151: зміна дати на зайняту → ConflictException, не P2002 generic 409.
    it('кидає ConflictException при зміні дати на зайняту (Bug #151)', async () => {
      prisma.exchangeRate.findFirst
        .mockResolvedValueOnce(fullRow({ date: new Date('2026-05-28') })) // existing record
        .mockResolvedValueOnce(fullRow({ id: 'er-2', date: new Date('2026-06-01') })); // duplicate on new date
      await expect(
        service.update('org-1', 'er-1', { date: '2026-06-01' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.exchangeRate.update).not.toHaveBeenCalled();
    });

    it('дозволяє оновлення без зміни дати (без перевірки дубля)', async () => {
      prisma.exchangeRate.findFirst.mockResolvedValueOnce(fullRow({ date: new Date('2026-05-28') }));
      await service.update('org-1', 'er-1', { rate: 43 });
      // findFirst викликається лише раз (existing), без duplicate-check
      expect(prisma.exchangeRate.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.exchangeRate.update).toHaveBeenCalledTimes(1);
    });

    it('кидає NotFoundException якщо курс не знайдено', async () => {
      prisma.exchangeRate.findFirst.mockResolvedValueOnce(null);
      await expect(service.update('org-1', 'missing', { rate: 1 })).rejects.toThrow(NotFoundException);
    });
  });
});
