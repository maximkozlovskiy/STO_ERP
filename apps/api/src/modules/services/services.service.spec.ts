import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ServicesService } from './services.service';
import { modelMock, type PrismaModelMock } from '../../common/testing/prisma-mock';

/**
 * ServicesService — модуль був БЕЗ тестів (аудит 2024-10).
 *
 * Сервіс (пакет робіт+товарів) — не просто CRUD: він складає склад пакета з FK на
 * `Work` і `Good`, тож головне, що тут варто стерегти:
 *
 *  - **cross-tenant FK guard через порівняння count** — `tx.work.count({id: {in}, orgId})`
 *    проти `dto.works.length`. Якщо хоч один `workId` належить ІНШІЙ org (або видалений),
 *    кількість не збіжиться → 404. Без цієї перевірки чужа робота тихо потрапила б у
 *    пакет, і вся арифметика пакета рахувалась би по недоступній роботі;
 *  - **`[]` ≠ `undefined`** в update: порожній масив означає «очистити склад», а
 *    відсутнє поле — «не чіпати». Переплутати їх = тихо затерти склад пакета;
 *  - **junction-рядки видаляються hard** (`serviceWork`/`serviceGood` не мають
 *    `deletedAt`), а сам `Service` — soft через `updateMany` (CLAUDE.md §5);
 *  - **tenant isolation** у кожному запиті.
 */
describe('ServicesService', () => {
  let svc: ServicesService;
  let tx: {
    service: PrismaModelMock;
    work: PrismaModelMock;
    good: PrismaModelMock;
    serviceWork: PrismaModelMock;
    serviceGood: PrismaModelMock;
  };
  let prisma: {
    service: PrismaModelMock;
    $transaction: ReturnType<typeof vi.fn>;
  };

  const ORG = 'org-1';
  const SVC_ID = 'svc-1';

  const row = (over: Record<string, unknown> = {}) => ({
    id: SVC_ID,
    orgId: ORG,
    name: 'ТО-1',
    description: null,
    price: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    deletedAt: null,
    serviceWorks: [],
    serviceGoods: [],
    ...over,
  });

  beforeEach(() => {
    tx = {
      service: modelMock('create', 'update', 'findFirstOrThrow', 'findFirst'),
      work: modelMock('count'),
      good: modelMock('count'),
      serviceWork: modelMock('createMany', 'deleteMany'),
      serviceGood: modelMock('createMany', 'deleteMany'),
    };
    tx.service.create.mockResolvedValue({ id: SVC_ID });
    tx.service.update.mockResolvedValue({ id: SVC_ID });
    tx.service.findFirstOrThrow.mockResolvedValue(row());
    tx.serviceWork.createMany.mockResolvedValue({ count: 1 });
    tx.serviceGood.createMany.mockResolvedValue({ count: 1 });
    tx.serviceWork.deleteMany.mockResolvedValue({ count: 0 });
    tx.serviceGood.deleteMany.mockResolvedValue({ count: 0 });

    prisma = {
      service: modelMock('findFirst', 'findMany', 'count', 'updateMany'),
      $transaction: vi.fn(async (cb: (c: typeof tx) => unknown) => cb(tx)),
    };
    prisma.service.findFirst.mockResolvedValue({ id: SVC_ID });
    prisma.service.findMany.mockResolvedValue([row()]);
    prisma.service.count.mockResolvedValue(1);
    prisma.service.updateMany.mockResolvedValue({ count: 1 });

    svc = new ServicesService(prisma as never);
  });

  describe('create — cross-tenant FK guard', () => {
    it('чужа/видалена робота у складі пакета → 404, рядки НЕ створюються', async () => {
      tx.work.count.mockResolvedValue(1); // попросили 2, знайшлась 1
      await expect(
        svc.create(ORG, {
          name: 'ТО',
          works: [{ workId: 'w-mine' }, { workId: 'w-foreign' }],
        } as never),
      ).rejects.toThrow(NotFoundException);
      expect(tx.serviceWork.createMany).not.toHaveBeenCalled();
    });

    it('чужий/видалений товар → 404', async () => {
      tx.good.count.mockResolvedValue(0);
      await expect(
        svc.create(ORG, { name: 'ТО', goods: [{ goodId: 'g-foreign' }] } as never),
      ).rejects.toThrow(NotFoundException);
      expect(tx.serviceGood.createMany).not.toHaveBeenCalled();
    });

    it('перевірка FK шукає ЛИШЕ у своїй org і лише не видалені', async () => {
      tx.work.count.mockResolvedValue(1);
      await svc.create(ORG, { name: 'ТО', works: [{ workId: 'w-1' }] } as never);
      expect(tx.work.count.mock.calls[0][0].where).toEqual({
        id: { in: ['w-1'] },
        orgId: ORG,
        deletedAt: null,
      });
    });

    it('усі FK свої → рядки складу створюються, quantity за замовчуванням 1', async () => {
      tx.work.count.mockResolvedValue(1);
      tx.good.count.mockResolvedValue(1);
      await svc.create(ORG, {
        name: 'ТО',
        works: [{ workId: 'w-1' }],
        goods: [{ goodId: 'g-1', quantity: 2.5 }],
      } as never);
      expect(tx.serviceWork.createMany.mock.calls[0][0].data).toEqual([
        { serviceId: SVC_ID, workId: 'w-1', quantity: 1 },
      ]);
      expect(tx.serviceGood.createMany.mock.calls[0][0].data).toEqual([
        { serviceId: SVC_ID, goodId: 'g-1', quantity: 2.5 },
      ]);
    });

    it('пакет без складу — створюється, count-перевірки не викликаються', async () => {
      await svc.create(ORG, { name: 'Порожній' } as never);
      expect(tx.work.count).not.toHaveBeenCalled();
      expect(tx.good.count).not.toHaveBeenCalled();
      expect(tx.serviceWork.createMany).not.toHaveBeenCalled();
    });

    it('orgId пишеться з контексту, не з DTO', async () => {
      await svc.create(ORG, { name: 'ТО', orgId: 'org-ATTACKER' } as never);
      expect(tx.service.create.mock.calls[0][0].data.orgId).toBe(ORG);
    });
  });

  describe('update — `[]` очищає склад, `undefined` не чіпає', () => {
    it('works: [] → склад очищається (deleteMany без createMany)', async () => {
      await svc.update(ORG, SVC_ID, { works: [] } as never);
      expect(tx.serviceWork.deleteMany).toHaveBeenCalledWith({ where: { serviceId: SVC_ID } });
      expect(tx.serviceWork.createMany).not.toHaveBeenCalled();
    });

    it('works відсутній → склад НЕ чіпається (ні deleteMany, ні createMany)', async () => {
      await svc.update(ORG, SVC_ID, { name: 'Нова назва' } as never);
      expect(tx.serviceWork.deleteMany).not.toHaveBeenCalled();
      expect(tx.serviceWork.createMany).not.toHaveBeenCalled();
    });

    it('works із чужим FK → 404 ДО видалення наявного складу', async () => {
      tx.work.count.mockResolvedValue(0);
      await expect(
        svc.update(ORG, SVC_ID, { works: [{ workId: 'w-foreign' }] } as never),
      ).rejects.toThrow(NotFoundException);
      // Критично: старий склад не має бути знесений, якщо новий невалідний.
      expect(tx.serviceWork.deleteMany).not.toHaveBeenCalled();
    });

    it('валідна заміна складу: спершу deleteMany, потім createMany', async () => {
      tx.work.count.mockResolvedValue(1);
      await svc.update(ORG, SVC_ID, { works: [{ workId: 'w-1', quantity: 3 }] } as never);
      expect(tx.serviceWork.deleteMany).toHaveBeenCalled();
      expect(tx.serviceWork.createMany.mock.calls[0][0].data).toEqual([
        { serviceId: SVC_ID, workId: 'w-1', quantity: 3 },
      ]);
    });

    it('неіснуючий/чужий пакет → 404, транзакція не стартує', async () => {
      prisma.service.findFirst.mockResolvedValue(null);
      await expect(svc.update(ORG, 'ghost', { name: 'x' } as never)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('existence-guard читає у своїй org і не видалене', async () => {
      await svc.update(ORG, SVC_ID, { name: 'x' } as never);
      expect(prisma.service.findFirst.mock.calls[0][0].where).toEqual({
        id: SVC_ID,
        orgId: ORG,
        deletedAt: null,
      });
    });

    it('price: null явно скидає ціну, відсутній price не чіпає її', async () => {
      await svc.update(ORG, SVC_ID, { price: null } as never);
      expect(tx.service.update.mock.calls[0][0].data.price).toBeNull();

      tx.service.update.mockClear();
      await svc.update(ORG, SVC_ID, { name: 'x' } as never);
      expect(tx.service.update.mock.calls[0][0].data.price).toBeUndefined();
    });
  });

  describe('remove — soft delete', () => {
    it('updateMany з deletedAt + orgId (hard delete заборонений, CLAUDE.md §5)', async () => {
      await svc.remove(ORG, SVC_ID);
      const call = prisma.service.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: SVC_ID, orgId: ORG, deletedAt: null });
      expect(call.data.deletedAt).toBeInstanceOf(Date);
    });

    it('count=0 (чужа org або вже видалено) → 404', async () => {
      prisma.service.updateMany.mockResolvedValue({ count: 0 });
      await expect(svc.remove(ORG, SVC_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('tenant isolation', () => {
    it('orgId у where кожного читання і запису складу', async () => {
      await svc.findAll(ORG);
      for (const call of prisma.service.findMany.mock.calls) {
        expect(call[0].where.orgId).toBe(ORG);
      }
      tx.work.count.mockResolvedValue(1);
      await svc.create(ORG, { name: 'ТО', works: [{ workId: 'w-1' }] } as never);
      expect(tx.work.count.mock.calls[0][0].where.orgId).toBe(ORG);
      expect(tx.service.findFirstOrThrow.mock.calls[0][0].where.orgId).toBe(ORG);
    });

    it('findOne чужого пакета → 404', async () => {
      prisma.service.findFirst.mockResolvedValue(null);
      await expect(svc.findOne(ORG, 'foreign')).rejects.toThrow(NotFoundException);
    });
  });
});
