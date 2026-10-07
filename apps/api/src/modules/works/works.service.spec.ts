import { describe, it, expect, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { WorksService } from './works.service';
import { modelMock, type PrismaModelMock } from '../../common/testing/prisma-mock';

/**
 * WorksService — модуль був БЕЗ тестів (аудит 2024-10: 12 таких модулів).
 *
 * Робота (`Work`) — позиція каталогу з FK на `WorkCategory`. Що тут справді варто
 * стерегти (а не просто «покриття»):
 *
 *  - **cross-tenant FK guard категорії** — create/update читають `WorkCategory`
 *    з `orgId` у where; чужа або видалена категорія → 404, і робота НЕ створюється;
 *  - **приховування робіт вимкнених категорій** — findAll без showDeleted додає
 *    `category: { isActive: true }`; це вкладений фільтр, не те саме, що `deletedAt`
 *    самої роботи;
 *  - **soft-delete через `updateMany`** з `orgId` у where (CLAUDE.md §5); count=0 → 404;
 *  - **restore** — атомарний `updateMany` з `NOT: { deletedAt: null }`, не можна
 *    «відновити» неіснуючу або живу роботу;
 *  - **tenant isolation** — `orgId` у where КОЖНОГО читання й запису.
 */
describe('WorksService', () => {
  let svc: WorksService;
  let prisma: { work: PrismaModelMock; workCategory: PrismaModelMock };

  const ORG = 'org-1';
  const ID = 'work-1';
  const CAT = 'cat-1';

  const row = (over: Record<string, unknown> = {}) => ({
    id: ID,
    orgId: ORG,
    categoryId: CAT,
    name: 'Заміна масла',
    normoHours: 1.5,
    price: 500 as unknown as import('@prisma/client').Prisma.Decimal,
    description: null,
    isWarranty: false,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    category: { name: 'ТО' },
    ...over,
  });

  const query = (over: Record<string, unknown> = {}) => ({ page: 1, limit: 50, ...over }) as never;

  beforeEach(() => {
    prisma = {
      work: modelMock(
        'findMany',
        'findFirst',
        'count',
        'create',
        'update',
        'updateMany',
        'findFirstOrThrow',
      ),
      workCategory: modelMock('findFirst'),
    };
    prisma.work.findMany.mockResolvedValue([row()]);
    prisma.work.count.mockResolvedValue(1);
    prisma.work.findFirst.mockResolvedValue(row());
    prisma.work.create.mockResolvedValue(row());
    prisma.work.update.mockResolvedValue(row());
    prisma.work.updateMany.mockResolvedValue({ count: 1 });
    prisma.work.findFirstOrThrow.mockResolvedValue(row());
    prisma.workCategory.findFirst.mockResolvedValue({ id: CAT });
    svc = new WorksService(prisma as never);
  });

  describe('findAll — фільтри каталогу', () => {
    it('без showDeleted: ховає видалені роботи І роботи вимкнених категорій', async () => {
      await svc.findAll(ORG, query());
      const where = prisma.work.findMany.mock.calls[0][0].where;
      expect(where.orgId).toBe(ORG);
      expect(where.deletedAt).toBeNull();
      // Вкладений фільтр: робота живої категорії; не плутати з deletedAt самої роботи.
      expect(where.category).toEqual({ isActive: true });
    });

    it('showDeleted=true: не фільтрує ні по deletedAt, ні по isActive категорії', async () => {
      await svc.findAll(ORG, query({ showDeleted: true }));
      const where = prisma.work.findMany.mock.calls[0][0].where;
      expect(where.deletedAt).toBeUndefined();
      expect(where.category).toBeUndefined();
      expect(where.orgId).toBe(ORG);
    });

    it('categoryIds має пріоритет над categoryId (in над одиничним)', async () => {
      await svc.findAll(ORG, query({ categoryIds: ['a', 'b'], categoryId: 'single' }));
      const where = prisma.work.findMany.mock.calls[0][0].where;
      expect(where.categoryId).toEqual({ in: ['a', 'b'] });
    });

    it('q → пошук по name з insensitive-режимом', async () => {
      await svc.findAll(ORG, query({ q: 'масл' }));
      const where = prisma.work.findMany.mock.calls[0][0].where;
      expect(where.name).toEqual({ contains: 'масл', mode: 'insensitive' });
    });

    it('count і findMany бачать той самий where (однакова tenant-ізоляція)', async () => {
      await svc.findAll(ORG, query());
      expect(prisma.work.count.mock.calls[0][0].where.orgId).toBe(ORG);
      expect(prisma.work.count.mock.calls[0][0].where.deletedAt).toBeNull();
    });
  });

  describe('findOne — tenant isolation', () => {
    it('читає у своїй org, не видалене', async () => {
      await svc.findOne(ORG, ID);
      expect(prisma.work.findFirst.mock.calls[0][0].where).toEqual({
        id: ID,
        orgId: ORG,
        deletedAt: null,
      });
    });

    it('чужа/видалена робота → 404 (не 200 з даними іншої org)', async () => {
      prisma.work.findFirst.mockResolvedValue(null);
      await expect(svc.findOne(ORG, 'foreign')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create — FK-guard категорії', () => {
    it('чужа/видалена категорія → 404, робота НЕ створюється', async () => {
      prisma.workCategory.findFirst.mockResolvedValue(null);
      await expect(
        svc.create(ORG, {
          categoryId: 'foreign-cat',
          name: 'X',
          normoHours: 1,
          price: 10,
        } as never),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.work.create).not.toHaveBeenCalled();
    });

    it('FK-guard шукає категорію у СВОЇЙ org і не видалену', async () => {
      await svc.create(ORG, { categoryId: CAT, name: 'X', normoHours: 1, price: 10 } as never);
      expect(prisma.workCategory.findFirst.mock.calls[0][0].where).toEqual({
        id: CAT,
        orgId: ORG,
        deletedAt: null,
      });
    });

    it('orgId пишеться з контексту, не з DTO', async () => {
      await svc.create(ORG, {
        categoryId: CAT,
        name: 'X',
        normoHours: 1,
        price: 10,
        orgId: 'org-ATTACKER',
      } as never);
      expect(prisma.work.create.mock.calls[0][0].data.orgId).toBe(ORG);
    });
  });

  describe('update — FK-guard категорії перед записом', () => {
    it('неіснуюча/чужа робота → 404, update не викликається', async () => {
      prisma.work.findFirst.mockResolvedValue(null);
      await expect(svc.update(ORG, 'ghost', { name: 'X' } as never)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.work.update).not.toHaveBeenCalled();
    });

    it('зміна categoryId на чужу категорію → 404 (робота існує, категорія ні)', async () => {
      prisma.work.findFirst.mockResolvedValue({ id: ID });
      prisma.workCategory.findFirst.mockResolvedValue(null);
      await expect(svc.update(ORG, ID, { categoryId: 'foreign-cat' } as never)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.work.update).not.toHaveBeenCalled();
    });

    it('без categoryId у DTO — категорію не перевіряємо', async () => {
      await svc.update(ORG, ID, { name: 'Нова назва' } as never);
      expect(prisma.workCategory.findFirst).not.toHaveBeenCalled();
      expect(prisma.work.update).toHaveBeenCalled();
    });

    it('update пише з orgId у where (tenant isolation)', async () => {
      await svc.update(ORG, ID, { name: 'X' } as never);
      expect(prisma.work.update.mock.calls[0][0].where).toEqual({ id: ID, orgId: ORG });
    });
  });

  describe('remove — soft delete', () => {
    it('updateMany з deletedAt + orgId (hard delete заборонений, CLAUDE.md §5)', async () => {
      await svc.remove(ORG, ID);
      const call = prisma.work.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: ID, orgId: ORG, deletedAt: null });
      expect(call.data.deletedAt).toBeInstanceOf(Date);
      expect(prisma.work.delete).toBeUndefined();
    });

    it('count=0 (чужа org або вже видалено) → 404', async () => {
      prisma.work.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.remove(ORG, ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('restore — лише видалене своєї org', () => {
    it('updateMany з NOT:{deletedAt:null} + orgId → можна відновити ЛИШЕ видалене', async () => {
      await svc.restore(ORG, ID);
      const call = prisma.work.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: ID, orgId: ORG, NOT: { deletedAt: null } });
      expect(call.data.deletedAt).toBeNull();
    });

    it('count=0 (не видалена або чужа) → 404, read-back не виконується', async () => {
      prisma.work.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.restore(ORG, ID)).rejects.toThrow(NotFoundException);
      expect(prisma.work.findFirstOrThrow).not.toHaveBeenCalled();
    });
  });

  describe('isWarranty — інформаційна позначка, на ціну не впливає', () => {
    // guards: BR-WORK-002
    it('create зберігає isWarranty=true і ціну роботи як є (не обнуляє)', async () => {
      await svc.create(ORG, {
        categoryId: CAT,
        name: 'Гарантійна заміна',
        normoHours: 1,
        price: 500,
        isWarranty: true,
      } as never);
      const data = prisma.work.create.mock.calls[0][0].data;
      expect(data.isWarranty).toBe(true);
      expect(data.price).toBe(500);
    });

    // guards: BR-WORK-002
    it('відповідь повертає isWarranty і ціну гарантійної роботи без змін', async () => {
      prisma.work.findFirst.mockResolvedValue(row({ isWarranty: true }));
      const dto = await svc.findOne(ORG, ID);
      expect(dto.isWarranty).toBe(true);
      expect(dto.price).toBe(500);
    });

    // guards: BR-WORK-002
    it('update isWarranty=true пише лише прапорець — ціну не чіпає', async () => {
      await svc.update(ORG, ID, { isWarranty: true } as never);
      expect(prisma.work.update.mock.calls[0][0].data).toEqual({ isWarranty: true });
    });
  });

  describe('tenant isolation — зведено', () => {
    it('orgId присутній у where кожного читання', async () => {
      await svc.findAll(ORG, query());
      await svc.findOne(ORG, ID);
      await svc.create(ORG, { categoryId: CAT, name: 'X', normoHours: 1, price: 10 } as never);
      expect(prisma.work.findMany.mock.calls[0][0].where.orgId).toBe(ORG);
      expect(prisma.work.findFirst.mock.calls[0][0].where.orgId).toBe(ORG);
      expect(prisma.workCategory.findFirst.mock.calls[0][0].where.orgId).toBe(ORG);
    });
  });
});
