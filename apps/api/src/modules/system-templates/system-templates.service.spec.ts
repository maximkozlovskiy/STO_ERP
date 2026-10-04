import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SystemTemplatesService } from './system-templates.service';
import { modelMock, type PrismaModelMock } from '../../common/testing/prisma-mock';

/**
 * SystemTemplatesService — глобальний seed-керований каталог шаблонів (НЕ per-org:
 * у моделі немає orgId, шаблони однакові для всіх організацій і міняються лише через
 * deploy/seed). Модуль був БЕЗ тестів. Інваріанти:
 *
 *  - **read-only**: сервіс не має create/update/delete (шаблони системні, не редагуються);
 *  - **take: 500** — явний OOM-guard (§3.2), навіть для seed-каталогу; легко прибрати;
 *  - **кеш розділяє ключ per-entityType і окремий ALL_KEY** — без entityType не можна
 *    віддати закешований зріз конкретного типу (і навпаки);
 *  - **cache-hit короткозамикає БД**;
 *  - **детермінований orderBy** (entityType, sortOrder) — порядок у UI стабільний.
 */
describe('SystemTemplatesService', () => {
  let prisma: { systemTemplate: PrismaModelMock };
  let cache: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
  let svc: SystemTemplatesService;

  const tpl = (over: Record<string, unknown> = {}) => ({
    id: 't-1',
    entityType: 'work-order',
    key: 'default',
    name: 'Стандартний',
    data: { foo: 'bar' },
    sortOrder: 0,
    ...over,
  });

  beforeEach(() => {
    prisma = { systemTemplate: modelMock('findMany') };
    prisma.systemTemplate.findMany.mockResolvedValue([tpl()]);
    cache = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) };
    svc = new SystemTemplatesService(prisma as never, cache as never);
  });

  describe('read-only контракт', () => {
    it('сервіс не експонує мутацій (системні шаблони не редагуються per-org)', () => {
      expect((svc as unknown as Record<string, unknown>).create).toBeUndefined();
      expect((svc as unknown as Record<string, unknown>).update).toBeUndefined();
      expect((svc as unknown as Record<string, unknown>).remove).toBeUndefined();
      expect((svc as unknown as Record<string, unknown>).delete).toBeUndefined();
    });
  });

  describe('OOM-guard і сортування', () => {
    it('findMany завжди з take: 500 (OOM-guard §3.2)', async () => {
      await svc.findAll();
      expect(prisma.systemTemplate.findMany.mock.calls[0][0].take).toBe(500);
    });

    it('детермінований orderBy: entityType asc, sortOrder asc', async () => {
      await svc.findAll();
      expect(prisma.systemTemplate.findMany.mock.calls[0][0].orderBy).toEqual([
        { entityType: 'asc' },
        { sortOrder: 'asc' },
      ]);
    });
  });

  describe('фільтр за entityType', () => {
    it('з entityType → where.entityType; без нього → where undefined (весь каталог)', async () => {
      await svc.findAll('work-order');
      expect(prisma.systemTemplate.findMany.mock.calls[0][0].where).toEqual({
        entityType: 'work-order',
      });

      prisma.systemTemplate.findMany.mockClear();
      await svc.findAll();
      expect(prisma.systemTemplate.findMany.mock.calls[0][0].where).toBeUndefined();
    });
  });

  describe('кеш', () => {
    it('ключ залежить від entityType; ALL_KEY — окремо', async () => {
      await svc.findAll('invoice');
      expect(cache.get.mock.calls[0][0]).toBe('sys:templates:invoice');

      cache.get.mockClear();
      await svc.findAll();
      expect(cache.get.mock.calls[0][0]).toBe('sys:templates:all');
    });

    it('cache-hit короткозамикає — БД не опитується', async () => {
      const cached = [tpl()].map(t => ({
        id: t.id,
        entityType: t.entityType,
        key: t.key,
        name: t.name,
        data: t.data,
        sortOrder: t.sortOrder,
      }));
      cache.get.mockResolvedValue(cached);
      const r = await svc.findAll('work-order');
      expect(r).toBe(cached);
      expect(prisma.systemTemplate.findMany).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('cache-miss → результат кладеться з TTL 3600 під тим самим ключем', async () => {
      await svc.findAll('invoice');
      expect(cache.set.mock.calls[0][0]).toBe('sys:templates:invoice');
      expect(cache.set.mock.calls[0][2]).toBe(3600);
    });
  });

  describe('мапінг DTO', () => {
    it('toDto переносить рівно публічні поля (data лишається об’єктом)', async () => {
      prisma.systemTemplate.findMany.mockResolvedValue([
        tpl({ id: 't-9', entityType: 'good', key: 'k', name: 'N', data: { a: 1 }, sortOrder: 3 }),
      ]);
      const r = await svc.findAll();
      expect(r[0]).toEqual({
        id: 't-9',
        entityType: 'good',
        key: 'k',
        name: 'N',
        data: { a: 1 },
        sortOrder: 3,
      });
    });
  });
});
