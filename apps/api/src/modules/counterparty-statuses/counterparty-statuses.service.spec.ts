import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CounterpartyStatusesService } from './counterparty-statuses.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CacheService } from '../../redis/cache.service';

// ─── Spec для CounterpartyStatusesService (довідник кастомних міток контрагентів) ──
//
// Дзеркалить BrandsService: create(resurrect-vs-conflict) / restore(active-dup guard) /
// remove(atomic soft-delete) / findAll(cache) / toDto(counterpartyCount з _count.links).
// `@@unique([orgId, name])` БЕЗ partial WHERE — resurrect і restore мають guard-и проти P2002.

const ORG = '11111111-1111-4111-8111-111111111111';
const STATUS_A = '22222222-2222-4222-8222-222222222222';
const DEFAULT_COLOR = '#6b7280';

function makeMocks() {
  return {
    prisma: {
      counterpartyStatus: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirstOrThrow: vi.fn(),
      },
    },
    cache: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
      del: vi.fn(),
    },
  };
}

function makeService(mocks: ReturnType<typeof makeMocks>): CounterpartyStatusesService {
  return new CounterpartyStatusesService(
    mocks.prisma as unknown as PrismaService,
    mocks.cache as unknown as CacheService,
  );
}

const row = (over: Record<string, unknown> = {}) => ({
  id: STATUS_A,
  orgId: ORG,
  name: 'VIP',
  color: DEFAULT_COLOR,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  _count: { links: 0 },
  ...over,
});

describe('CounterpartyStatusesService.create', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let service: CounterpartyStatusesService;

  beforeEach(() => {
    mocks = makeMocks();
    service = makeService(mocks);
  });

  it('активний дубль назви → ConflictException, create НЕ викликається', async () => {
    mocks.prisma.counterpartyStatus.findFirst.mockResolvedValueOnce({
      id: 'active-dup',
      deletedAt: null,
    });

    await expect(service.create(ORG, { name: 'VIP' })).rejects.toThrow(ConflictException);
    expect(mocks.prisma.counterpartyStatus.create).not.toHaveBeenCalled();
  });

  it('soft-deleted дубль → resurrect (update deletedAt:null), а не create', async () => {
    mocks.prisma.counterpartyStatus.findFirst.mockResolvedValueOnce({
      id: 'tomb',
      deletedAt: new Date(),
    });
    mocks.prisma.counterpartyStatus.findFirstOrThrow.mockResolvedValueOnce(row({ id: 'tomb' }));

    await service.create(ORG, { name: 'VIP', color: '#f59e0b' });

    expect(mocks.prisma.counterpartyStatus.update).toHaveBeenCalledWith({
      where: { id: 'tomb', orgId: ORG },
      data: { name: 'VIP', color: '#f59e0b', deletedAt: null },
    });
    expect(mocks.prisma.counterpartyStatus.create).not.toHaveBeenCalled();
    expect(mocks.cache.del).toHaveBeenCalled();
  });

  it('нова назва без color → create з DEFAULT_COLOR + скидання кешу', async () => {
    mocks.prisma.counterpartyStatus.findFirst.mockResolvedValueOnce(null);
    mocks.prisma.counterpartyStatus.create.mockResolvedValueOnce(row());

    const result = await service.create(ORG, { name: 'VIP' });

    expect(mocks.prisma.counterpartyStatus.create).toHaveBeenCalledWith({
      data: { name: 'VIP', color: DEFAULT_COLOR, orgId: ORG },
      // counterpartyCount рахує лише активних контрагентів (link на soft-deleted cp не рахується).
      include: { _count: { select: { links: { where: { counterparty: { deletedAt: null } } } } } },
    });
    expect(result.color).toBe(DEFAULT_COLOR);
    expect(mocks.cache.del).toHaveBeenCalled();
  });
});

describe('CounterpartyStatusesService.restore — active-name-duplicate guard', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let service: CounterpartyStatusesService;

  beforeEach(() => {
    mocks = makeMocks();
    service = makeService(mocks);
  });

  it('активний дубль назви → ConflictException, updateMany НЕ викликається', async () => {
    mocks.prisma.counterpartyStatus.findFirst
      .mockResolvedValueOnce({ name: 'VIP' }) // deleted lookup
      .mockResolvedValueOnce({ id: 'active-dup' }); // active duplicate

    await expect(service.restore(ORG, STATUS_A)).rejects.toThrow(ConflictException);
    expect(mocks.prisma.counterpartyStatus.updateMany).not.toHaveBeenCalled();
  });

  it('немає активного дубля → restore проходить (updateMany deletedAt:null)', async () => {
    mocks.prisma.counterpartyStatus.findFirst
      .mockResolvedValueOnce({ name: 'VIP' }) // deleted lookup
      .mockResolvedValueOnce(null); // no active duplicate
    mocks.prisma.counterpartyStatus.findFirstOrThrow.mockResolvedValueOnce(row());

    await service.restore(ORG, STATUS_A);

    expect(mocks.prisma.counterpartyStatus.updateMany).toHaveBeenCalledWith({
      where: { id: STATUS_A, orgId: ORG, NOT: { deletedAt: null } },
      data: { deletedAt: null },
    });
  });

  it('видаленого рядка немає → NotFoundException', async () => {
    mocks.prisma.counterpartyStatus.findFirst.mockResolvedValueOnce(null);

    await expect(service.restore(ORG, STATUS_A)).rejects.toThrow(NotFoundException);
    expect(mocks.prisma.counterpartyStatus.updateMany).not.toHaveBeenCalled();
  });
});

describe('CounterpartyStatusesService.remove — atomic soft-delete', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let service: CounterpartyStatusesService;

  beforeEach(() => {
    mocks = makeMocks();
    service = makeService(mocks);
  });

  it('успіх → updateMany з deletedAt:Date (compound where id+orgId+deletedAt:null) + скидання кешу', async () => {
    mocks.prisma.counterpartyStatus.updateMany.mockResolvedValueOnce({ count: 1 });

    await service.remove(ORG, STATUS_A);

    expect(mocks.prisma.counterpartyStatus.updateMany).toHaveBeenCalledWith({
      where: { id: STATUS_A, orgId: ORG, deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
    expect(mocks.cache.del).toHaveBeenCalled();
  });

  it('нічого не оновлено (count=0) → NotFoundException, кеш не скидається', async () => {
    mocks.prisma.counterpartyStatus.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.remove(ORG, STATUS_A)).rejects.toThrow(NotFoundException);
    expect(mocks.cache.del).not.toHaveBeenCalled();
  });
});

describe('CounterpartyStatusesService.findAll — cache + counterpartyCount', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let service: CounterpartyStatusesService;

  beforeEach(() => {
    mocks = makeMocks();
    service = makeService(mocks);
  });

  it('cache hit → повертає кешоване, БД не чіпається', async () => {
    const cached = { items: [], total: 0 };
    mocks.cache.get.mockResolvedValueOnce(cached);

    const result = await service.findAll(ORG);

    expect(result).toBe(cached);
    expect(mocks.prisma.counterpartyStatus.findMany).not.toHaveBeenCalled();
  });

  it('cache miss → counterpartyCount з _count.links, кеш записується', async () => {
    mocks.cache.get.mockResolvedValueOnce(null);
    mocks.prisma.counterpartyStatus.findMany.mockResolvedValueOnce([row({ _count: { links: 3 } })]);
    mocks.prisma.counterpartyStatus.count.mockResolvedValueOnce(1);

    const result = await service.findAll(ORG);

    expect(result.items[0].counterpartyCount).toBe(3);
    expect(mocks.cache.set).toHaveBeenCalled();
  });

  it('counterpartyCount рахує лише активних контрагентів (_count.links фільтрує soft-deleted cp)', async () => {
    // Регресія Bug: link на soft-deleted контрагента завищував лічильник (видалення cp
    // з міткою залишало counterpartyCount без змін). Include має нести where-фільтр.
    mocks.cache.get.mockResolvedValueOnce(null);
    mocks.prisma.counterpartyStatus.findMany.mockResolvedValueOnce([]);
    mocks.prisma.counterpartyStatus.count.mockResolvedValueOnce(0);

    await service.findAll(ORG);

    expect(mocks.prisma.counterpartyStatus.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          _count: { select: { links: { where: { counterparty: { deletedAt: null } } } } },
        },
      }),
    );
  });

  it('showDeleted=true → кеш не читається і не пишеться', async () => {
    mocks.prisma.counterpartyStatus.findMany.mockResolvedValueOnce([]);
    mocks.prisma.counterpartyStatus.count.mockResolvedValueOnce(0);

    await service.findAll(ORG, true);

    expect(mocks.cache.get).not.toHaveBeenCalled();
    expect(mocks.cache.set).not.toHaveBeenCalled();
  });
});

describe('CounterpartyStatusesService.invalidateCache', () => {
  it('скидає кеш-ключ довідника (для assign/unassign з counterparties-модуля)', async () => {
    const mocks = makeMocks();
    const service = makeService(mocks);

    await service.invalidateCache(ORG);

    expect(mocks.cache.del).toHaveBeenCalledWith(`ref:counterparty-statuses:${ORG}`);
  });
});
