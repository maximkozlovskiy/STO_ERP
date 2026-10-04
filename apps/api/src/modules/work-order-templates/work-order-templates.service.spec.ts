import { describe, it, expect, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { WorkOrderTemplatesService } from './work-order-templates.service';
import { modelMock, type PrismaModelMock } from '../../common/testing/prisma-mock';

/**
 * WorkOrderTemplatesService — модуль був БЕЗ тестів (аудит 2024-10: 12 таких модулів).
 *
 * Шаблон наряду зберігає `lines`/`parts` як JSON-колонки. Що тут варто стерегти:
 *
 *  - **ліміт `take: 200`** у findAll — захист довідника від роздування;
 *  - **1-RTT soft-delete/update через `updateMany`** з `orgId`+`deletedAt:null` у where
 *    (CLAUDE.md §5); count=0 → 404 ДО read-back;
 *  - **часткове оновлення JSON** — поле у data з'являється ЛИШЕ коли `!== undefined`:
 *    відсутнє поле не чіпає збережений JSON, а `[]` явно очищає його;
 *  - **дефолти create** — `lines`/`parts` = `[]`, а не `undefined` (щоб у БД не ліг null);
 *  - **tenant isolation** — `orgId` у where кожного читання/запису.
 */
describe('WorkOrderTemplatesService', () => {
  let svc: WorkOrderTemplatesService;
  let prisma: { workOrderTemplate: PrismaModelMock };

  const ORG = 'org-1';
  const ID = 'tpl-1';

  const row = (over: Record<string, unknown> = {}) => ({
    id: ID,
    orgId: ORG,
    name: 'ТО-1 пакет',
    lines: [],
    parts: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  });

  beforeEach(() => {
    prisma = {
      workOrderTemplate: modelMock('findMany', 'count', 'findFirst', 'create', 'updateMany'),
    };
    prisma.workOrderTemplate.findMany.mockResolvedValue([row()]);
    prisma.workOrderTemplate.count.mockResolvedValue(1);
    prisma.workOrderTemplate.findFirst.mockResolvedValue(row());
    prisma.workOrderTemplate.create.mockResolvedValue(row());
    prisma.workOrderTemplate.updateMany.mockResolvedValue({ count: 1 });
    svc = new WorkOrderTemplatesService(prisma as never);
  });

  describe('findAll — ліміт і tenant isolation', () => {
    it('where з orgId + deletedAt:null, ліміт 200', async () => {
      await svc.findAll(ORG);
      const call = prisma.workOrderTemplate.findMany.mock.calls[0][0];
      expect(call.where).toEqual({ orgId: ORG, deletedAt: null });
      expect(call.take).toBe(200);
      expect(prisma.workOrderTemplate.count.mock.calls[0][0].where).toEqual({
        orgId: ORG,
        deletedAt: null,
      });
    });
  });

  describe('findOne — tenant isolation', () => {
    it('читає у своїй org, не видалене', async () => {
      await svc.findOne(ORG, ID);
      expect(prisma.workOrderTemplate.findFirst.mock.calls[0][0].where).toEqual({
        id: ID,
        orgId: ORG,
        deletedAt: null,
      });
    });

    it('чужий/видалений шаблон → 404', async () => {
      prisma.workOrderTemplate.findFirst.mockResolvedValue(null);
      await expect(svc.findOne(ORG, 'foreign')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create — дефолти і orgId', () => {
    it('без lines/parts → у data порожні масиви (не undefined/null)', async () => {
      await svc.create(ORG, { name: 'X' } as never);
      const data = prisma.workOrderTemplate.create.mock.calls[0][0].data;
      expect(data.lines).toEqual([]);
      expect(data.parts).toEqual([]);
      expect(data.orgId).toBe(ORG);
    });

    it('передані lines/parts зберігаються як є', async () => {
      const lines = [{ workId: 'w-1', quantity: 2 }];
      const parts = [{ goodId: 'g-1', quantity: 5 }];
      await svc.create(ORG, { name: 'X', lines, parts } as never);
      const data = prisma.workOrderTemplate.create.mock.calls[0][0].data;
      expect(data.lines).toEqual(lines);
      expect(data.parts).toEqual(parts);
    });
  });

  describe('update — часткове оновлення JSON через updateMany', () => {
    it('відсутнє поле у DTO → не потрапляє у data (JSON не затирається)', async () => {
      await svc.update(ORG, ID, { name: 'Нова назва' } as never);
      const data = prisma.workOrderTemplate.updateMany.mock.calls[0][0].data;
      expect(data.name).toBe('Нова назва');
      expect('lines' in data).toBe(false);
      expect('parts' in data).toBe(false);
    });

    it('lines: [] явно очищає склад (поле присутнє зі значенням [])', async () => {
      await svc.update(ORG, ID, { lines: [] } as never);
      const data = prisma.workOrderTemplate.updateMany.mock.calls[0][0].data;
      expect('lines' in data).toBe(true);
      expect(data.lines).toEqual([]);
    });

    it('updateMany пише з повним tenant-where (orgId + deletedAt:null)', async () => {
      await svc.update(ORG, ID, { name: 'X' } as never);
      expect(prisma.workOrderTemplate.updateMany.mock.calls[0][0].where).toEqual({
        id: ID,
        orgId: ORG,
        deletedAt: null,
      });
    });

    it('count=0 (чужий/видалений/неіснуючий) → 404 ДО read-back', async () => {
      prisma.workOrderTemplate.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.update(ORG, 'ghost', { name: 'X' } as never)).rejects.toThrow(
        NotFoundException,
      );
      // read-back findFirst не повинен навіть викликатись
      expect(prisma.workOrderTemplate.findFirst).not.toHaveBeenCalled();
    });

    it('read-back повертає оновлений рядок через toDto', async () => {
      prisma.workOrderTemplate.findFirst.mockResolvedValue(row({ name: 'Оновлено' }));
      const res = await svc.update(ORG, ID, { name: 'Оновлено' } as never);
      expect(res.name).toBe('Оновлено');
    });
  });

  describe('remove — soft delete', () => {
    it('updateMany з deletedAt + повний tenant-where (hard delete заборонений)', async () => {
      await svc.remove(ORG, ID);
      const call = prisma.workOrderTemplate.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: ID, orgId: ORG, deletedAt: null });
      expect(call.data.deletedAt).toBeInstanceOf(Date);
      expect(prisma.workOrderTemplate.delete).toBeUndefined();
    });

    it('count=0 (чужа org або вже видалено) → 404', async () => {
      prisma.workOrderTemplate.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.remove(ORG, ID)).rejects.toThrow(NotFoundException);
    });
  });
});
