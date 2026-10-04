import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CommentsService } from './comments.service';
import { modelMock, type PrismaModelMock } from '../../common/testing/prisma-mock';

/**
 * CommentsService — модуль був БЕЗ тестів (аудит 2024-10: 12 таких модулів).
 *
 * Коментар — поліморфний запис (`entityType`+`entityId`) БЕЗ Prisma-FK. Через це
 * tenant/FK-інваріанти тримаються ЛИШЕ кодом сервісу, і саме їх треба стерегти:
 *
 *  - **whitelist entityType** — довільний рядок → 400 (інакше зондування будь-яких
 *    значень обходить контракт поліморфного зв'язку і псує індекс);
 *  - **cross-tenant FK guard** — батьківська сутність читається з `orgId`+`deletedAt:null`;
 *    чужа/видалена → 404, коментар НЕ створюється (інакше у БД осідає orphan-коментар,
 *    невидимий обом org, що ламає audit-trail);
 *  - **право на видалення** — лише автор або OWNER/ADMIN; інакше будь-який працівник
 *    затирає чужі нотатки;
 *  - **atomic hard deleteMany з orgId** — у `Comment` НЕМА колонки `deletedAt`
 *    (перевірено у схемі), тож hard delete тут ЗА ЗАДУМОМ; orgId у where закриває
 *    race-window між guard-читанням і видаленням (cross-tenant під конкурентним доступом);
 *  - **tenant isolation** — `orgId` у where кожного читання/запису.
 */
describe('CommentsService', () => {
  let svc: CommentsService;
  let prisma: {
    comment: PrismaModelMock;
    workOrder: PrismaModelMock;
    counterparty: PrismaModelMock;
    vehicle: PrismaModelMock;
    invoice: PrismaModelMock;
  };

  const ORG = 'org-1';
  const AUTHOR = 'emp-author';
  const COMMENT_ID = 'c-1';
  const ENTITY_ID = 'wo-1';

  const commentRow = (over: Record<string, unknown> = {}) => ({
    id: COMMENT_ID,
    orgId: ORG,
    entityType: 'WorkOrder',
    entityId: ENTITY_ID,
    body: 'Текст',
    authorId: AUTHOR,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    author: { firstName: 'Іван', lastName: 'Петренко' },
    ...over,
  });

  beforeEach(() => {
    prisma = {
      comment: modelMock('findMany', 'count', 'create', 'findFirst', 'deleteMany'),
      workOrder: modelMock('findFirst'),
      counterparty: modelMock('findFirst'),
      vehicle: modelMock('findFirst'),
      invoice: modelMock('findFirst'),
    };
    prisma.comment.findMany.mockResolvedValue([commentRow()]);
    prisma.comment.count.mockResolvedValue(1);
    prisma.comment.create.mockResolvedValue(commentRow());
    prisma.comment.findFirst.mockResolvedValue({ authorId: AUTHOR });
    prisma.comment.deleteMany.mockResolvedValue({ count: 1 });
    prisma.workOrder.findFirst.mockResolvedValue({ id: ENTITY_ID });
    prisma.counterparty.findFirst.mockResolvedValue({ id: ENTITY_ID });
    prisma.vehicle.findFirst.mockResolvedValue({ id: ENTITY_ID });
    prisma.invoice.findFirst.mockResolvedValue({ id: ENTITY_ID });
    svc = new CommentsService(prisma as never);
  });

  describe('findAll — whitelist entityType і tenant isolation', () => {
    it('невідомий entityType → 400, у БД не ходимо', async () => {
      await expect(svc.findAll(ORG, 'Secret', ENTITY_ID)).rejects.toThrow(BadRequestException);
      expect(prisma.comment.findMany).not.toHaveBeenCalled();
    });

    it('порожній entityId → 400', async () => {
      await expect(svc.findAll(ORG, 'WorkOrder', '')).rejects.toThrow(BadRequestException);
    });

    it('валідний запит: where містить orgId + entityType + entityId, ліміт 500', async () => {
      await svc.findAll(ORG, 'WorkOrder', ENTITY_ID);
      const call = prisma.comment.findMany.mock.calls[0][0];
      expect(call.where).toEqual({ orgId: ORG, entityType: 'WorkOrder', entityId: ENTITY_ID });
      expect(call.take).toBe(500);
      // count бачить той самий tenant-scoped where
      expect(prisma.comment.count.mock.calls[0][0].where.orgId).toBe(ORG);
    });

    it('authorName збирається з firstName + lastName', async () => {
      const res = await svc.findAll(ORG, 'WorkOrder', ENTITY_ID);
      expect(res.items[0].authorName).toBe('Іван Петренко');
    });
  });

  describe('create — cross-tenant FK guard поліморфної сутності', () => {
    it('чужа/видалена батьківська сутність → 404, коментар НЕ створюється', async () => {
      prisma.workOrder.findFirst.mockResolvedValue(null);
      await expect(
        svc.create(ORG, AUTHOR, {
          entityType: 'WorkOrder',
          entityId: 'foreign',
          body: 'x',
        } as never),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.comment.create).not.toHaveBeenCalled();
    });

    it('FK guard читає батька у СВОЇЙ org і не видаленого', async () => {
      await svc.create(ORG, AUTHOR, {
        entityType: 'WorkOrder',
        entityId: ENTITY_ID,
        body: 'x',
      } as never);
      expect(prisma.workOrder.findFirst.mock.calls[0][0].where).toEqual({
        id: ENTITY_ID,
        orgId: ORG,
        deletedAt: null,
      });
    });

    it('entityType маршрутизується до правильної моделі (Vehicle → prisma.vehicle)', async () => {
      await svc.create(ORG, AUTHOR, {
        entityType: 'Vehicle',
        entityId: ENTITY_ID,
        body: 'x',
      } as never);
      expect(prisma.vehicle.findFirst).toHaveBeenCalled();
      expect(prisma.workOrder.findFirst).not.toHaveBeenCalled();
    });

    it('orgId і authorId пишуться з контексту, не з DTO', async () => {
      await svc.create(ORG, AUTHOR, {
        entityType: 'WorkOrder',
        entityId: ENTITY_ID,
        body: 'x',
        orgId: 'org-ATTACKER',
        authorId: 'emp-ATTACKER',
      } as never);
      const data = prisma.comment.create.mock.calls[0][0].data;
      expect(data.orgId).toBe(ORG);
      expect(data.authorId).toBe(AUTHOR);
    });
  });

  describe('remove — право на видалення + atomic hard delete', () => {
    it('неіснуючий/чужий коментар → 404', async () => {
      prisma.comment.findFirst.mockResolvedValue(null);
      await expect(svc.remove(ORG, 'ghost', { id: AUTHOR, role: 'MECHANIC' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('чужий автор + не адмін → 403, deleteMany НЕ викликається', async () => {
      prisma.comment.findFirst.mockResolvedValue({ authorId: 'someone-else' });
      await expect(svc.remove(ORG, COMMENT_ID, { id: AUTHOR, role: 'MECHANIC' })).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.comment.deleteMany).not.toHaveBeenCalled();
    });

    it('автор може видалити свій коментар', async () => {
      prisma.comment.findFirst.mockResolvedValue({ authorId: AUTHOR });
      await expect(
        svc.remove(ORG, COMMENT_ID, { id: AUTHOR, role: 'MECHANIC' }),
      ).resolves.toBeUndefined();
      expect(prisma.comment.deleteMany).toHaveBeenCalled();
    });

    it('ADMIN може видалити чужий коментар', async () => {
      prisma.comment.findFirst.mockResolvedValue({ authorId: 'someone-else' });
      await svc.remove(ORG, COMMENT_ID, { id: 'admin-x', role: 'ADMIN' });
      expect(prisma.comment.deleteMany).toHaveBeenCalled();
    });

    it('OWNER може видалити чужий коментар', async () => {
      prisma.comment.findFirst.mockResolvedValue({ authorId: 'someone-else' });
      await svc.remove(ORG, COMMENT_ID, { id: 'owner-x', role: 'OWNER' });
      expect(prisma.comment.deleteMany).toHaveBeenCalled();
    });

    it('видалення — HARD deleteMany з orgId у where (Comment не має deletedAt — за задумом схеми)', async () => {
      await svc.remove(ORG, COMMENT_ID, { id: AUTHOR, role: 'MECHANIC' });
      // orgId у where закриває race-window: конкурентна сесія іншої org не зможе видалити.
      expect(prisma.comment.deleteMany.mock.calls[0][0]).toEqual({
        where: { id: COMMENT_ID, orgId: ORG },
      });
      // Саме deleteMany (hard), бо у Comment немає deletedAt для soft-delete.
      expect(prisma.comment.updateMany).toBeUndefined();
    });

    it('deleteMany count=0 (зникнув між guard і видаленням) → 404', async () => {
      prisma.comment.deleteMany.mockResolvedValue({ count: 0 });
      await expect(svc.remove(ORG, COMMENT_ID, { id: AUTHOR, role: 'MECHANIC' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('permission-guard читає коментар у своїй org', async () => {
      await svc.remove(ORG, COMMENT_ID, { id: AUTHOR, role: 'MECHANIC' });
      expect(prisma.comment.findFirst.mock.calls[0][0].where).toEqual({
        id: COMMENT_ID,
        orgId: ORG,
      });
    });
  });
});
