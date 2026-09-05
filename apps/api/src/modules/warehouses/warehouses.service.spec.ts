import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { WarehousesService } from './warehouses.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';

describe('WarehousesService — isMain invariant', () => {
  let service: WarehousesService;
  let prisma: {
    warehouse: any;
    garageBranch: any;
    stockItem: any;
    $transaction: ReturnType<typeof vi.fn>;
  };
  let cache: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    delPattern: ReturnType<typeof vi.fn>;
  };

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
      stockItem: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      $transaction: vi
        .fn()
        .mockImplementation(async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma)),
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
        id: 'w-new',
        orgId: 'org-1',
        branchId: 'b-1',
        name: 'Новий',
        type: 'MAIN',
        isMain: true,
        createdAt: new Date(),
        updatedAt: new Date(),
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
        id: 'w-2',
        orgId: 'org-1',
        branchId: 'b-1',
        name: 'Другорядний',
        type: 'WORKSHOP',
        isMain: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await service.create('org-1', { branchId: 'b-1', name: 'Другорядний' });

      expect(prisma.warehouse.updateMany).not.toHaveBeenCalled();
    });

    it('кидає NotFoundException якщо branch не знайдено', async () => {
      prisma.garageBranch.findFirst.mockResolvedValueOnce(null);
      await expect(service.create('org-1', { branchId: 'b-missing', name: 'X' })).rejects.toThrow(
        NotFoundException,
      );
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
        id: 'w-1',
        orgId: 'org-1',
        branchId: 'b-1',
        name: 'X',
        type: 'MAIN',
        isMain: false,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      prisma.warehouse.update.mockResolvedValueOnce({
        id: 'w-1',
        orgId: 'org-1',
        branchId: 'b-1',
        name: 'X',
        type: 'MAIN',
        isMain: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await service.update('org-1', 'w-1', { isMain: true });

      expect(prisma.warehouse.updateMany).toHaveBeenCalledWith({
        where: { orgId: 'org-1', deletedAt: null, id: { not: 'w-1' } },
        data: { isMain: false },
      });
    });

    it('конвертує Prisma P2002 у ConflictException у update теж', async () => {
      prisma.warehouse.findFirst.mockResolvedValueOnce({
        id: 'w-1',
        orgId: 'org-1',
        branchId: 'b-1',
        name: 'X',
        type: 'MAIN',
        isMain: false,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
        meta: { target: ['orgId'] },
      });
      prisma.warehouse.update.mockRejectedValueOnce(p2002);

      await expect(service.update('org-1', 'w-1', { isMain: true })).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('remove — auto-promote next sibling after deleting isMain (Bug #355)', () => {
    it('soft-delete isMain → auto-promote найстарший active sibling як isMain', async () => {
      // existing: target warehouse є isMain
      prisma.warehouse.findFirst
        .mockResolvedValueOnce({ id: 'w-main', isMain: true })
        // next sibling lookup всередині $transaction
        .mockResolvedValueOnce({ id: 'w-next' });
      prisma.warehouse.updateMany
        .mockResolvedValueOnce({ count: 1 }) // soft-delete
        .mockResolvedValueOnce({ count: 1 }); // promote

      await service.remove('org-1', 'w-main');

      // 1й updateMany — soft-delete target
      expect(prisma.warehouse.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'w-main', orgId: 'org-1', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
      // 2й updateMany — promote next sibling
      expect(prisma.warehouse.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'w-next', orgId: 'org-1', deletedAt: null },
        data: { isMain: true },
      });
    });

    it('soft-delete non-main → НЕ викликає promote', async () => {
      prisma.warehouse.findFirst.mockResolvedValueOnce({ id: 'w-secondary', isMain: false });
      prisma.warehouse.updateMany.mockResolvedValueOnce({ count: 1 });

      await service.remove('org-1', 'w-secondary');

      // Лише 1 виклик updateMany — soft-delete; promote не виконується
      expect(prisma.warehouse.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.warehouse.findFirst).toHaveBeenCalledTimes(1); // не шукаємо next sibling
    });

    it('soft-delete isMain коли НЕМАЄ інших активних → не падає, soft-delete виконується', async () => {
      prisma.warehouse.findFirst
        .mockResolvedValueOnce({ id: 'w-only', isMain: true })
        .mockResolvedValueOnce(null); // нема next sibling
      prisma.warehouse.updateMany.mockResolvedValueOnce({ count: 1 });

      await service.remove('org-1', 'w-only');

      expect(prisma.warehouse.updateMany).toHaveBeenCalledTimes(1); // лише soft-delete
    });

    it('кидає NotFoundException якщо warehouse не існує / уже видалено', async () => {
      prisma.warehouse.findFirst.mockResolvedValueOnce(null);
      await expect(service.remove('org-1', 'w-missing')).rejects.toThrow(NotFoundException);
      expect(prisma.warehouse.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('remove — cascade guard: ненульові залишки (MD-H1 клас)', () => {
    it('блокує видалення складу з quantity/reserved > 0 → BadRequestException, БЕЗ soft-delete', async () => {
      prisma.warehouse.findFirst.mockResolvedValueOnce({ id: 'w-1', isMain: false });
      // на складі є StockItem із ненульовим залишком
      prisma.stockItem.findFirst.mockResolvedValueOnce({ id: 'si-1' });

      await expect(service.remove('org-1', 'w-1')).rejects.toThrow(BadRequestException);

      // Проти старого коду (без guard) updateMany викликався б → падіння цього assert.
      expect(prisma.warehouse.updateMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      // guard шукає саме ненульові рядки цього складу
      expect(prisma.stockItem.findFirst).toHaveBeenCalledWith({
        where: {
          orgId: 'org-1',
          warehouseId: 'w-1',
          deletedAt: null,
          OR: [{ quantity: { not: 0 } }, { reserved: { not: 0 } }],
        },
        select: { id: true },
      });
    });

    it('дозволяє видалення складу з нульовими залишками (guard повертає null)', async () => {
      prisma.warehouse.findFirst.mockResolvedValueOnce({ id: 'w-empty', isMain: false });
      prisma.stockItem.findFirst.mockResolvedValueOnce(null);
      prisma.warehouse.updateMany.mockResolvedValueOnce({ count: 1 });

      await service.remove('org-1', 'w-empty');

      expect(prisma.warehouse.updateMany).toHaveBeenCalled();
    });
  });
});
