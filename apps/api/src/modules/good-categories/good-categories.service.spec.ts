import { Test, TestingModule } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GoodCategoriesService } from './good-categories.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../redis/cache.service';

const ORG_ID = 'org-1';
const ID = '11111111-1111-4111-8111-111111111111';
const PARENT_ID = '22222222-2222-4222-8222-222222222222';

describe('GoodCategoriesService — business rules', () => {
  let service: GoodCategoriesService;
  let prisma: {
    goodCategory: {
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      findFirstOrThrow: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    good: { updateMany: ReturnType<typeof vi.fn> };
    workGoodCategoryLink: { findMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let cache: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    prisma = {
      goodCategory: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        findFirstOrThrow: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      good: { updateMany: vi.fn() },
      workGoodCategoryLink: { findMany: vi.fn() },
      $transaction: vi.fn(async fn => fn(prisma)),
    };
    cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn(), del: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoodCategoriesService,
        { provide: PrismaService, useValue: prisma },
        { provide: CacheService, useValue: cache },
      ],
    }).compile();

    service = module.get(GoodCategoriesService);
  });

  describe('update — Bug #319 (isSystem guard)', () => {
    it('блокує PATCH name на системній категорії → BadRequestException', async () => {
      prisma.goodCategory.findFirst.mockResolvedValueOnce({ id: ID, isSystem: true }); // existing
      await expect(service.update(ORG_ID, ID, { name: 'Підмінено' })).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.goodCategory.updateMany).not.toHaveBeenCalled();
    });

    it('блокує PATCH parentId на системній категорії → BadRequestException', async () => {
      prisma.goodCategory.findFirst
        .mockResolvedValueOnce({ id: ID, isSystem: true }) // existing
        .mockResolvedValueOnce({ id: PARENT_ID }); // parent
      await expect(service.update(ORG_ID, ID, { parentId: PARENT_ID })).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.goodCategory.updateMany).not.toHaveBeenCalled();
    });

    it('дозволяє PATCH sortOrder на системній категорії (косметика per-org)', async () => {
      prisma.goodCategory.findFirst.mockResolvedValueOnce({ id: ID, isSystem: true });
      prisma.goodCategory.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.goodCategory.findFirstOrThrow.mockResolvedValueOnce({
        id: ID,
        orgId: ORG_ID,
        parentId: null,
        name: 'Двигун',
        code: 'ENG',
        isSystem: true,
        isActive: true,
        sortOrder: 5,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const result = await service.update(ORG_ID, ID, { sortOrder: 5 });
      expect(result.sortOrder).toBe(5);
      expect(prisma.goodCategory.updateMany).toHaveBeenCalledWith({
        where: { id: ID, orgId: ORG_ID, deletedAt: null },
        data: { sortOrder: 5 },
      });
    });

    it('дозволяє PATCH name на не-системній (custom) категорії', async () => {
      prisma.goodCategory.findFirst.mockResolvedValueOnce({ id: ID, isSystem: false });
      prisma.goodCategory.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.goodCategory.findFirstOrThrow.mockResolvedValueOnce({
        id: ID,
        orgId: ORG_ID,
        parentId: null,
        name: 'Нова',
        code: null,
        isSystem: false,
        isActive: true,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const result = await service.update(ORG_ID, ID, { name: 'Нова' });
      expect(result.name).toBe('Нова');
    });

    it('кидає NotFoundException якщо категорії не існує', async () => {
      prisma.goodCategory.findFirst.mockResolvedValueOnce(null); // existing=null
      await expect(service.update(ORG_ID, ID, { name: 'X' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove — Bug #320 (isSystem guard) + cascade to goods', () => {
    it('блокує DELETE системної категорії → BadRequestException', async () => {
      prisma.goodCategory.findFirst.mockResolvedValueOnce({ id: ID, isSystem: true });
      await expect(service.remove(ORG_ID, ID)).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('кидає NotFoundException якщо категорії не існує', async () => {
      prisma.goodCategory.findFirst.mockResolvedValueOnce(null);
      await expect(service.remove(ORG_ID, ID)).rejects.toThrow(NotFoundException);
    });

    it('видаляє не-системну категорію + каскадно nullить goodCategoryId у товарів', async () => {
      prisma.goodCategory.findFirst.mockResolvedValueOnce({ id: ID, isSystem: false });
      prisma.goodCategory.findMany.mockResolvedValueOnce([]); // no descendants
      prisma.good.updateMany.mockResolvedValueOnce({ count: 3 });
      prisma.goodCategory.updateMany.mockResolvedValueOnce({ count: 1 });

      await service.remove(ORG_ID, ID);

      // Goods cascade — goodCategoryId → null
      expect(prisma.good.updateMany).toHaveBeenCalledWith({
        where: { orgId: ORG_ID, goodCategoryId: { in: [ID] }, deletedAt: null },
        data: { goodCategoryId: null },
      });
      // Soft delete of category itself
      expect(prisma.goodCategory.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [ID] }, orgId: ORG_ID, deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
    });
  });

  describe('toggleActive — Bug #321 (deletedAt guard at write)', () => {
    it('updateMany з повним where (id, orgId, deletedAt: null) — defense-in-depth', async () => {
      prisma.goodCategory.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.goodCategory.findFirstOrThrow.mockResolvedValueOnce({
        id: ID,
        orgId: ORG_ID,
        parentId: null,
        name: 'Х',
        code: null,
        isSystem: false,
        isActive: false,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await service.toggleActive(ORG_ID, ID, false);
      expect(prisma.goodCategory.updateMany).toHaveBeenCalledWith({
        where: { id: ID, orgId: ORG_ID, deletedAt: null },
        data: { isActive: false },
      });
    });

    it('кидає NotFoundException якщо updateMany.count === 0 (soft-deleted або не з цієї org)', async () => {
      prisma.goodCategory.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.toggleActive(ORG_ID, ID, true)).rejects.toThrow(NotFoundException);
    });
  });

  describe('create — tenant FK validation for parentId', () => {
    it('кидає NotFoundException якщо parentId з чужої org', async () => {
      prisma.goodCategory.findFirst.mockResolvedValueOnce(null); // parent not in org
      await expect(
        service.create(ORG_ID, { name: 'Підкатегорія', parentId: PARENT_ID }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.goodCategory.create).not.toHaveBeenCalled();
    });

    it('встановлює isSystem=false для новостворених через API (системні створює тільки seed-catalog)', async () => {
      prisma.goodCategory.create.mockResolvedValueOnce({
        id: ID,
        orgId: ORG_ID,
        parentId: null,
        name: 'Custom',
        code: null,
        isSystem: false,
        isActive: true,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await service.create(ORG_ID, { name: 'Custom' });
      expect(prisma.goodCategory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ orgId: ORG_ID, isSystem: false }),
      });
    });
  });
});
