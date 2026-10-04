import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { BranchesService } from './branches.service';
import { modelMock, type PrismaModelMock } from '../../common/testing/prisma-mock';

/**
 * BranchesService — модуль був БЕЗ тестів (аудит 2024-10: 12 таких модулів).
 *
 * Філія (`GarageBranch`) — простий reference-довідник, але з кешем. Що тут варто
 * стерегти:
 *
 *  - **кеш читається ЛИШЕ для не-видалених** (showDeleted=false) і інвалідується
 *    на кожному записі (create/update/remove) — інакше список філій «застрягає»;
 *  - **ліміт `take: 500`** у findAll — захист від роздування довідника;
 *  - **soft-delete через `updateMany`** з `orgId` у where (CLAUDE.md §5); count=0 → 404;
 *  - **tenant isolation** — `orgId` у where КОЖНОГО читання й запису, і у ключі кешу.
 */
describe('BranchesService', () => {
  let svc: BranchesService;
  let prisma: { garageBranch: PrismaModelMock };
  let cache: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };

  const ORG = 'org-1';
  const ID = 'branch-1';

  const row = (over: Record<string, unknown> = {}) => ({
    id: ID,
    orgId: ORG,
    name: 'Центральна',
    address: 'вул. Хрещатик, 1',
    timezone: 'Europe/Kyiv',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...over,
  });

  beforeEach(() => {
    prisma = {
      garageBranch: modelMock('findMany', 'findFirst', 'create', 'update', 'updateMany'),
    };
    prisma.garageBranch.findMany.mockResolvedValue([row()]);
    prisma.garageBranch.findFirst.mockResolvedValue(row());
    prisma.garageBranch.create.mockResolvedValue(row());
    prisma.garageBranch.update.mockResolvedValue(row());
    prisma.garageBranch.updateMany.mockResolvedValue({ count: 1 });

    cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn(), del: vi.fn() };

    svc = new BranchesService(prisma as never, cache as never);
  });

  describe('findAll — кеш і фільтри', () => {
    it('ключ кешу містить orgId (ізоляція кешу між org)', async () => {
      await svc.findAll(ORG);
      expect(cache.get.mock.calls[0][0]).toBe(`ref:branches:${ORG}`);
      expect(cache.set.mock.calls[0][0]).toBe(`ref:branches:${ORG}`);
    });

    it('кеш-hit → повертає кешоване, БД не чіпається', async () => {
      cache.get.mockResolvedValue([row({ name: 'з кешу' })]);
      const res = await svc.findAll(ORG);
      expect(res[0].name).toBe('з кешу');
      expect(prisma.garageBranch.findMany).not.toHaveBeenCalled();
    });

    it('кеш-miss → читає БД з orgId + deletedAt:null, ліміт 500, пише кеш', async () => {
      await svc.findAll(ORG);
      const call = prisma.garageBranch.findMany.mock.calls[0][0];
      expect(call.where).toEqual({ orgId: ORG, deletedAt: null });
      expect(call.take).toBe(500);
      expect(cache.set).toHaveBeenCalled();
    });

    it('showDeleted=true → кеш НЕ читається і НЕ пишеться, where без deletedAt', async () => {
      await svc.findAll(ORG, true);
      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
      const where = prisma.garageBranch.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ orgId: ORG });
    });
  });

  describe('findOne — tenant isolation', () => {
    it('читає у своїй org, не видалене', async () => {
      await svc.findOne(ORG, ID);
      expect(prisma.garageBranch.findFirst.mock.calls[0][0].where).toEqual({
        id: ID,
        orgId: ORG,
        deletedAt: null,
      });
    });

    it('чужа/видалена філія → 404', async () => {
      prisma.garageBranch.findFirst.mockResolvedValue(null);
      await expect(svc.findOne(ORG, 'foreign')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create — orgId з контексту + інвалідація кешу', () => {
    it('orgId пишеться з контексту, не з DTO; кеш скидається', async () => {
      await svc.create(ORG, { name: 'Нова', address: 'вул.', orgId: 'org-ATTACKER' } as never);
      expect(prisma.garageBranch.create.mock.calls[0][0].data.orgId).toBe(ORG);
      expect(cache.del).toHaveBeenCalledWith(`ref:branches:${ORG}`);
    });
  });

  describe('update — guard, запис, інвалідація', () => {
    it('неіснуюча/чужа філія → 404, update не викликається, кеш не чіпається', async () => {
      prisma.garageBranch.findFirst.mockResolvedValue(null);
      await expect(svc.update(ORG, 'ghost', { name: 'X' } as never)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.garageBranch.update).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
    });

    it('guard читає у своїй org; update пише з orgId у where; кеш скидається', async () => {
      await svc.update(ORG, ID, { name: 'X' } as never);
      expect(prisma.garageBranch.findFirst.mock.calls[0][0].where).toEqual({
        id: ID,
        orgId: ORG,
        deletedAt: null,
      });
      expect(prisma.garageBranch.update.mock.calls[0][0].where).toEqual({ id: ID, orgId: ORG });
      expect(cache.del).toHaveBeenCalledWith(`ref:branches:${ORG}`);
    });
  });

  describe('remove — soft delete', () => {
    it('updateMany з deletedAt + orgId (hard delete заборонений); кеш скидається', async () => {
      await svc.remove(ORG, ID);
      const call = prisma.garageBranch.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: ID, orgId: ORG, deletedAt: null });
      expect(call.data.deletedAt).toBeInstanceOf(Date);
      expect(prisma.garageBranch.delete).toBeUndefined();
      expect(cache.del).toHaveBeenCalledWith(`ref:branches:${ORG}`);
    });

    it('count=0 (чужа org або вже видалено) → 404, кеш НЕ скидається', async () => {
      prisma.garageBranch.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.remove(ORG, ID)).rejects.toThrow(NotFoundException);
      expect(cache.del).not.toHaveBeenCalled();
    });
  });
});
