import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WorkCategoriesService } from './work-categories.service';
import { modelMock, type PrismaModelMock } from '../../common/testing/prisma-mock';

/**
 * WorkCategoriesService — юніт із моком Prisma (взірець: `works/works.service.spec.ts`).
 *
 * До цього файла модуль мав лише контрактний спек із ЗАМОКАНИМ сервісом, тобто жодне
 * правило самого сервісу не перевірялось. Що тут стережемо (дос'є `docs/objects/work.md`):
 *
 *  - **BR-WORK-003** — системну категорію не можна видалити: бекенд авторитетний, UI лише
 *    ховає кнопку. Без гарда raw-запит із валідним JWT стирає системний каталог;
 *  - **BR-WORK-005** — бекенд не обмежує глибину ієрархії: дерево будується рекурсивно,
 *    створення під батьком будь-якого рівня дозволене (ліміт у три рівні — лише в UI).
 */
describe('WorkCategoriesService', () => {
  let svc: WorkCategoriesService;
  let prisma: { workCategory: PrismaModelMock };
  let cache: Record<'get' | 'set' | 'del', ReturnType<typeof vi.fn>>;

  const ORG = 'org-1';
  const ID = 'cat-1';

  const row = (over: Record<string, unknown> = {}) => ({
    id: ID,
    orgId: ORG,
    parentId: null,
    name: 'Ходова',
    code: null,
    icon: null,
    sortOrder: 0,
    isSystem: false,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  });

  beforeEach(() => {
    prisma = {
      workCategory: modelMock('findMany', 'findFirst', 'findFirstOrThrow', 'create', 'updateMany'),
    };
    prisma.workCategory.findMany.mockResolvedValue([]);
    prisma.workCategory.findFirst.mockResolvedValue({ id: ID, isSystem: false });
    prisma.workCategory.findFirstOrThrow.mockResolvedValue(row());
    prisma.workCategory.create.mockResolvedValue(row());
    prisma.workCategory.updateMany.mockResolvedValue({ count: 1 });
    cache = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      del: vi.fn().mockResolvedValue(undefined),
    };
    svc = new WorkCategoriesService(prisma as never, cache as never);
  });

  describe('remove — системна категорія не видаляється', () => {
    // guards: BR-WORK-003
    it('isSystem=true → 400, жодного запису в БД і кеш не скидається', async () => {
      prisma.workCategory.findFirst.mockResolvedValue({ id: ID, isSystem: true });
      await expect(svc.remove(ORG, ID)).rejects.toThrow(BadRequestException);
      expect(prisma.workCategory.updateMany).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
    });

    it('звичайна категорія → soft-delete її та всіх нащадків у своїй org', async () => {
      prisma.workCategory.findMany.mockResolvedValue([
        { id: ID, parentId: null },
        { id: 'child', parentId: ID },
        { id: 'grandchild', parentId: 'child' },
        { id: 'other-root', parentId: null },
      ]);
      await svc.remove(ORG, ID);
      const call = prisma.workCategory.updateMany.mock.calls[0][0];
      expect(call.where.orgId).toBe(ORG);
      expect(call.where.deletedAt).toBeNull();
      expect([...call.where.id.in].sort()).toEqual(['cat-1', 'child', 'grandchild']);
      expect(call.data.deletedAt).toBeInstanceOf(Date);
      expect(prisma.workCategory.delete).toBeUndefined();
      expect(cache.del).toHaveBeenCalledWith(`ref:work-categories:${ORG}`);
    });

    it('чужа/видалена категорія → 404, запису немає', async () => {
      prisma.workCategory.findFirst.mockResolvedValue(null);
      await expect(svc.remove(ORG, 'foreign')).rejects.toThrow(NotFoundException);
      expect(prisma.workCategory.updateMany).not.toHaveBeenCalled();
    });

    it('гард читає категорію у СВОЇЙ org і не видалену', async () => {
      await svc.remove(ORG, ID);
      expect(prisma.workCategory.findFirst.mock.calls[0][0].where).toEqual({
        id: ID,
        orgId: ORG,
        deletedAt: null,
      });
    });
  });

  describe('update — системну категорію не перейменувати й не перенести', () => {
    it('isSystem=true + name → 400, updateMany не викликається', async () => {
      prisma.workCategory.findFirst.mockResolvedValue({ id: ID, isSystem: true });
      await expect(svc.update(ORG, ID, { name: 'Інша назва' } as never)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.workCategory.updateMany).not.toHaveBeenCalled();
    });

    it('isSystem=true + лише sortOrder/icon → дозволено (косметика per-org)', async () => {
      prisma.workCategory.findFirst.mockResolvedValue({ id: ID, isSystem: true });
      await svc.update(ORG, ID, { sortOrder: 5, icon: 'wrench' } as never);
      expect(prisma.workCategory.updateMany.mock.calls[0][0].data).toEqual({
        sortOrder: 5,
        icon: 'wrench',
      });
    });
  });

  describe('update — перенесення без циклів', () => {
    it('категорія батьком самої себе → 400, нічого не записано', async () => {
      await expect(svc.update(ORG, ID, { parentId: ID } as never)).rejects.toThrow(
        'Категорія не може бути власним батьком',
      );
      expect(prisma.workCategory.updateMany).not.toHaveBeenCalled();
    });

    it('перенесення у власного онука → 400, нічого не записано', async () => {
      // cat-1 → cat-2 → cat-3; переносимо cat-1 під cat-3.
      prisma.workCategory.findMany.mockResolvedValue([
        { id: ID, parentId: null },
        { id: 'cat-2', parentId: ID },
        { id: 'cat-3', parentId: 'cat-2' },
      ]);
      await expect(svc.update(ORG, ID, { parentId: 'cat-3' } as never)).rejects.toThrow(
        'Неможливо перенести категорію у власну підкатегорію',
      );
      expect(prisma.workCategory.updateMany).not.toHaveBeenCalled();
    });

    it('перенесення під сусідню гілку дозволено', async () => {
      prisma.workCategory.findMany.mockResolvedValue([
        { id: ID, parentId: null },
        { id: 'cat-2', parentId: ID },
        { id: 'other', parentId: null },
      ]);
      await svc.update(ORG, ID, { parentId: 'other' } as never);
      expect(prisma.workCategory.updateMany).toHaveBeenCalledTimes(1);
    });

    it('цикл, що вже є в даних, не зациклює видалення: нащадки обходяться один раз', async () => {
      // Дані з часу до захисту: cat-1 → cat-2 → cat-3 → cat-1 (cat-1 перенесли під онука).
      prisma.workCategory.findMany.mockResolvedValue([
        { id: ID, parentId: 'cat-3' },
        { id: 'cat-2', parentId: ID },
        { id: 'cat-3', parentId: 'cat-2' },
      ]);
      await svc.remove(ORG, ID);
      const ids = (prisma.workCategory.updateMany.mock.calls[0][0].where.id as { in: string[] }).in;
      expect([...ids].sort()).toEqual([ID, 'cat-2', 'cat-3'].sort());
    });
  });

  describe('ієрархія — бекенд не обмежує глибину', () => {
    // guards: BR-WORK-005
    it('findAll будує дерево з чотирьох рівнів без обрізання', async () => {
      prisma.workCategory.findMany.mockResolvedValue([
        row({ id: 'l1', name: 'Рівень 1', parentId: null }),
        row({ id: 'l2', name: 'Рівень 2', parentId: 'l1' }),
        row({ id: 'l3', name: 'Рівень 3', parentId: 'l2' }),
        row({ id: 'l4', name: 'Рівень 4', parentId: 'l3' }),
      ]);
      const tree = await svc.findAll(ORG);
      expect(tree).toHaveLength(1);
      const l2 = tree[0]!.children[0]!;
      const l3 = l2.children[0]!;
      const l4 = l3.children[0]!;
      expect([tree[0]!.id, l2.id, l3.id, l4.id]).toEqual(['l1', 'l2', 'l3', 'l4']);
      expect(l4.children).toEqual([]);
    });

    // guards: BR-WORK-005
    it('create під батьком, який сам є вкладеним, не відхиляється', async () => {
      // Батько третього рівня: UI (category-manager-modal) тут уже блокує кнопку,
      // а бекенд перевіряє лише існування батька у своїй org.
      prisma.workCategory.findFirst.mockResolvedValue({ id: 'l3', parentId: 'l2' });
      prisma.workCategory.create.mockResolvedValue(row({ id: 'l4', parentId: 'l3' }));
      const created = await svc.create(ORG, { name: 'Рівень 4', parentId: 'l3' } as never);
      expect(created.parentId).toBe('l3');
      expect(prisma.workCategory.create.mock.calls[0][0].data).toEqual({
        name: 'Рівень 4',
        parentId: 'l3',
        orgId: ORG,
      });
    });

    it('create з чужим/видаленим батьком → 404, категорія не створюється', async () => {
      prisma.workCategory.findFirst.mockResolvedValue(null);
      await expect(svc.create(ORG, { name: 'X', parentId: 'foreign' } as never)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.workCategory.create).not.toHaveBeenCalled();
    });
  });
});
