import { describe, it, expect, vi } from 'vitest';
import { SyncService } from '../sync/sync.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { WorkOrdersService } from '../work-orders/work-orders.service';
import type { CacheService } from '../../redis/cache.service';
import { fakeTask, mechA, taskHarness } from './tasks.spec-fixture';

/**
 * Задачі в синхронізації (`/sync/pull` — ролі керування): таблиця `tasks` віддається дельтою за
 * `syncVersion`, але не приймається на запис — статус змінюється лише переходом FSM
 * (`POST /tasks/:id/transition`, BR-TASK-003), а не перезаписом рядка з клієнта.
 */

function syncOver(task: Record<string, unknown>) {
  const prisma = {
    task: { findMany: vi.fn().mockResolvedValue([task]), updateMany: vi.fn(), upsert: vi.fn() },
    syncJob: { create: vi.fn() },
  };
  // Решта таблиць pull — порожні (інакше кожна писала б «невідома модель» у журнал).
  const empty = { findMany: vi.fn().mockResolvedValue([]) };
  const db = new Proxy(prisma, {
    get: (target, prop) =>
      prop in target ? (target as Record<string | symbol, unknown>)[prop] : empty,
  });
  const sync = new SyncService(
    db as unknown as PrismaService,
    {} as WorkOrdersService,
    { del: vi.fn() } as unknown as CacheService,
  );
  return { prisma, sync };
}

describe('Задачі в синхронізації', () => {
  // guards: BR-TASK-003
  it('pull: рядки tasks — з таблицею «tasks», syncVersion — число, курсор у where', async () => {
    const task = fakeTask({ syncVersion: 7n, title: 'Синхро' });
    const { prisma, sync } = syncOver(task);

    const records = await sync.pull('org-1', 3n);
    const own = records.filter(r => r.table === 'tasks');

    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ id: task.id, operation: 'UPDATE', syncVersion: 7 });
    expect(own[0].payload).toMatchObject({ title: 'Синхро', syncVersion: 7 });
    expect(prisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: 'org-1', syncVersion: { gt: 3n } } }),
    );
  });

  // guards: BR-TASK-003
  it('push у tasks → конфлікт, рядок не змінено (статус — лише через transition)', async () => {
    const task = fakeTask();
    const { prisma, sync } = syncOver(task);

    const res = await sync.push(
      'org-1',
      [
        {
          table: 'tasks',
          id: task.id as string,
          operation: 'UPDATE',
          syncVersion: 2,
          payload: { status: 'DONE' },
        },
      ],
      'OWNER',
    );

    expect(res).toEqual({ accepted: 0, conflicts: 1 });
    expect(prisma.task.updateMany).not.toHaveBeenCalled();
    expect(prisma.task.upsert).not.toHaveBeenCalled();
  });

  // guards: BR-TASK-003
  it('планшет: виконані за completedAt desc, порожні в кінці; далі createdAt і id — стабільні сторінки', async () => {
    const { service, prisma } = taskHarness();

    await service.findAll('org-1', mechA, {
      mine: '1',
      status: ['DONE'],
      sortBy: 'completedAt',
      sortDir: 'desc',
      page: 1,
      limit: 50,
    });

    const args = prisma.task.findMany.mock.calls[0][0] as unknown as { orderBy: unknown };
    expect(args.orderBy).toEqual([
      { completedAt: { sort: 'desc', nulls: 'last' } },
      { createdAt: 'desc' },
      { id: 'asc' },
    ]);
  });
});
