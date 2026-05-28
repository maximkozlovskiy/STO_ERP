import { Test } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { WarehousesService } from './warehouses.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';

describe('WarehousesService — isMain invariant', () => {
  let service: WarehousesService;
  let prisma: { warehouse: any; garageBranch: any; $transaction: ReturnType<typeof vi.fn> };
  let cache: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn>; delPattern: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    cache = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      del: vi.fn().mockResolvedValue(undefined),
      delPattern: vi.fn().mockResolvedValue(undefined),
    };
    prisma = {
      warehouse: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      garageBranch: {
        findFirst: vi.fn(),
      },
      $transaction: vi.fn().mockImplementation(async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma)),
    };

    const module = await Test.createTestingModule({
      providers: [
        WarehousesService,
        { provide: PrismaService, useValue: prisma },
        { provide: CacheService, useValue: cache },
      ],
    }).compile();

    service = module.get(WarehousesService);
  });

  describe('findAll', () => {
    it('сортує isMain desc, потім name asc', async () => {
      prisma.warehouse.findMany.mockResolvedValueOnce([]);
      await service.findAll('org-1');
      expect(prisma.warehouse.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ isMain: 'desc' }, { name: 'asc' }],
        }),
      );
    });

    it('фільтрує по deletedAt=null і orgId', async () => {
      prisma.warehouse.findMany.mockResolvedValueOnce([]);
      await service.findAll('org-1', 'branch-1');
      expect(prisma.warehouse.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { orgId: 'org-1', deletedAt: null, branchId: 'branch-1' },
        }),
      );
    });
  });

  describe('create — isMain UX guard', () => {
    it('коли isMain=true, скидає isMain у ВСІХ інших складах організації', async () => {
      prisma.garageBranch.findFirst.mockResolvedValueOnce({ id: 'b-1' });
      prisma.warehouse.create.mockResolvedValueOnce({
        id: 'w-new', orgId: 'org-1', branchId: 'b-1', name: 'Новий',
        type: 'MAIN', isMain: true, createdAt: new Date(), updatedAt: new Date(),
      });

      await service.create('org-1', { branchId: 'b-1', name: 'Новий', isMain: true });

      expect(prisma.warehouse.updateMany).toHaveBeenCalledWith({
        where: { orgId: 'org-1', deletedAt: null },
        data: { isMain: false },
      });
    });

    it('коли isMain не задано, НЕ викликає updateMany', async () => {
      prisma.garageBranch.findFirst.mockResolvedValueOnce({ id: 'b-1' });
      prisma.warehouse.create.mockResolvedValueOnce({
        id: 'w-2', orgId: 'org-1', branchId: 'b-1', name: 'Другорядний',
        type: 'WORKSHOP', isMain: false, createdAt: new Date(), updatedAt: new Date(),
      });

      await service.create('org-1', { branchId: 'b-1', name: 'Другорядний' });

      expect(prisma.warehouse.updateMany).not.toHaveBeenCalled();
    });

    it('кидає NotFoundException якщо branch не знайдено', async () => {
      prisma.garageBranch.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.create('org-1', { branchId: 'b-missing', name: 'X' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('конвертує Prisma P2002 у ConflictException з повідомленням українською', async () => {
      prisma.garageBranch.findFirst.mockResolvedValueOnce({ id: 'b-1' });
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['orgId'] },
      });
      // create викликається в межах $transaction callback — кидаємо звідти
      prisma.warehouse.create.mockRejectedValueOnce(p2002);

      await expect(
        service.create('org-1', { branchId: 'b-1', name: 'X', isMain: true }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('update — isMain UX guard', () => {
    it('коли isMain=true, скидає isMain у інших складах (id != target)', async () => {
      prisma.warehouse.findFirst.mockResolvedValueOnce({
        id: 'w-1', orgId: 'org-1', branchId: 'b-1', name: 'X', type: 'MAIN',
        isMain: false, deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      });
      prisma.warehouse.update.mockResolvedValueOnce({
        id: 'w-1', orgId: 'org-1', branchId: 'b-1', name: 'X', type: 'MAIN',
        isMain: true, createdAt: new Date(), updatedAt: new Date(),
      });

      await service.update('org-1', 'w-1', { isMain: true });

      expect(prisma.warehouse.updateMany).toHaveBeenCalledWith({
        where: { orgId: 'org-1', deletedAt: null, id: { not: 'w-1' } },
        data: { isMain: false },
      });
    });

    it('конвертує Prisma P2002 у ConflictException у update теж', async () => {
      prisma.warehouse.findFirst.mockResolvedValueOnce({
        id: 'w-1', orgId: 'org-1', branchId: 'b-1', name: 'X', type: 'MAIN',
        isMain: false, deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
      });
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['orgId'] },
      });
      prisma.warehouse.update.mockRejectedValueOnce(p2002);

      await expect(
        service.update('org-1', 'w-1', { isMain: true }),
      ).rejects.toThrow(ConflictException);
    });
  });
});
