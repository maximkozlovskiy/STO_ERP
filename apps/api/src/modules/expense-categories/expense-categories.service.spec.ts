import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ExpenseCategoriesService } from './expense-categories.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CacheService } from '../../redis/cache.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

function makeMocks() {
  return {
    prisma: {
      expenseCategory: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirstOrThrow: vi.fn(),
      },
    },
    cache: { get: vi.fn().mockResolvedValue(null), set: vi.fn(), del: vi.fn() },
  };
}
function makeService(m: ReturnType<typeof makeMocks>): ExpenseCategoriesService {
  return new ExpenseCategoriesService(
    m.prisma as unknown as PrismaService,
    m.cache as unknown as CacheService,
  );
}
const row = (o: Record<string, unknown> = {}) => ({
  id: ID,
  orgId: ORG,
  name: 'Оренда',
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...o,
});

describe('ExpenseCategoriesService', () => {
  let m: ReturnType<typeof makeMocks>;
  let service: ExpenseCategoriesService;
  beforeEach(() => {
    m = makeMocks();
    service = makeService(m);
  });

  it('create: активний дубль → 409', async () => {
    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce({ id: 'dup', deletedAt: null });
    await expect(service.create(ORG, { name: 'Оренда' })).rejects.toThrow(ConflictException);
    expect(m.prisma.expenseCategory.create).not.toHaveBeenCalled();
  });

  it('create: soft-deleted дубль → resurrect (update, не create)', async () => {
    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce({ id: 'tomb', deletedAt: new Date() });
    m.prisma.expenseCategory.findFirstOrThrow.mockResolvedValueOnce(row({ id: 'tomb' }));
    await service.create(ORG, { name: 'Оренда' });
    expect(m.prisma.expenseCategory.update).toHaveBeenCalledWith({
      where: { id: 'tomb', orgId: ORG },
      data: { name: 'Оренда', deletedAt: null },
    });
    expect(m.prisma.expenseCategory.create).not.toHaveBeenCalled();
  });

  it('create: нова → create + скидання кешу', async () => {
    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce(null);
    m.prisma.expenseCategory.create.mockResolvedValueOnce(row());
    await service.create(ORG, { name: 'Оренда' });
    expect(m.prisma.expenseCategory.create).toHaveBeenCalled();
    expect(m.cache.del).toHaveBeenCalled();
  });

  it('restore: активний дубль → 409, updateMany не викликається', async () => {
    m.prisma.expenseCategory.findFirst
      .mockResolvedValueOnce({ name: 'Оренда' })
      .mockResolvedValueOnce({ id: 'active-dup' });
    await expect(service.restore(ORG, ID)).rejects.toThrow(ConflictException);
    expect(m.prisma.expenseCategory.updateMany).not.toHaveBeenCalled();
  });

  it('remove: count=0 → 404', async () => {
    m.prisma.expenseCategory.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.remove(ORG, ID)).rejects.toThrow(NotFoundException);
  });

  it('findAll: cache hit → БД не чіпається', async () => {
    const cached = { items: [], total: 0 };
    m.cache.get.mockResolvedValueOnce(cached);
    const res = await service.findAll(ORG);
    expect(res).toBe(cached);
    expect(m.prisma.expenseCategory.findMany).not.toHaveBeenCalled();
  });
});
