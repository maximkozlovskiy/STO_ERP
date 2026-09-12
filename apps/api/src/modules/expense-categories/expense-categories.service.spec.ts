import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ExpenseCategoriesService } from './expense-categories.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CacheService } from '../../redis/cache.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const PARENT = '33333333-3333-4333-8333-333333333333';

function makeMocks() {
  return {
    prisma: {
      expenseCategory: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
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
  parentId: null,
  name: 'Оренда',
  type: 'EXPENSE',
  sortOrder: 0,
  isActive: true,
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
    // finish() перечитує рядок після мутації.
    m.prisma.expenseCategory.findFirstOrThrow.mockResolvedValue(row());
  });

  it('create: активний дубль → 409', async () => {
    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce({ id: 'dup', deletedAt: null });
    await expect(service.create(ORG, { name: 'Оренда' })).rejects.toThrow(ConflictException);
    expect(m.prisma.expenseCategory.create).not.toHaveBeenCalled();
  });

  it('create: soft-deleted дубль → resurrect (update, не create)', async () => {
    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce({ id: 'tomb', deletedAt: new Date() });
    await service.create(ORG, { name: 'Оренда' });
    expect(m.prisma.expenseCategory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tomb', orgId: ORG },
        data: expect.objectContaining({ name: 'Оренда', deletedAt: null }),
      }),
    );
    expect(m.prisma.expenseCategory.create).not.toHaveBeenCalled();
  });

  it('create: нова → create + скидання кешу; type за замовч. EXPENSE', async () => {
    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce(null);
    m.prisma.expenseCategory.create.mockResolvedValueOnce(row());
    await service.create(ORG, { name: 'Оренда' });
    expect(m.prisma.expenseCategory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'EXPENSE', parentId: null }),
      }),
    );
    expect(m.cache.del).toHaveBeenCalled();
  });

  it('create INCOME: type задається явно', async () => {
    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce(null);
    m.prisma.expenseCategory.create.mockResolvedValueOnce(row({ type: 'INCOME' }));
    await service.create(ORG, { name: 'Продаж матеріалів', type: 'INCOME' });
    expect(m.prisma.expenseCategory.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'INCOME' }) }),
    );
  });

  it('create дитина: тип успадковується від батька', async () => {
    // 1-й findFirst: parent lookup → INCOME; 2-й: дубль назви → null.
    m.prisma.expenseCategory.findFirst
      .mockResolvedValueOnce({ type: 'INCOME' })
      .mockResolvedValueOnce(null);
    m.prisma.expenseCategory.create.mockResolvedValueOnce(
      row({ parentId: PARENT, type: 'INCOME' }),
    );
    await service.create(ORG, { name: 'Підстаття', parentId: PARENT });
    expect(m.prisma.expenseCategory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'INCOME', parentId: PARENT }),
      }),
    );
  });

  it('create дитина: невідомий батько → 404', async () => {
    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce(null); // parent lookup
    await expect(service.create(ORG, { name: 'X', parentId: PARENT })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('create дитина: явний type ≠ type батька → 400', async () => {
    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce({ type: 'EXPENSE' }); // parent
    await expect(
      service.create(ORG, { name: 'X', parentId: PARENT, type: 'INCOME' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('update: перенесення у власного нащадка → 400 (цикл)', async () => {
    m.prisma.expenseCategory.findFirst
      .mockResolvedValueOnce({ id: ID, type: 'EXPENSE' }) // existing
      .mockResolvedValueOnce({ type: 'EXPENSE' }); // new parent lookup
    // getDescendantIds: findMany повертає, що PARENT — нащадок ID.
    m.prisma.expenseCategory.findMany.mockResolvedValueOnce([{ id: PARENT, parentId: ID }]);
    await expect(service.update(ORG, ID, { parentId: PARENT })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('update: новий батько іншого типу → 400', async () => {
    m.prisma.expenseCategory.findFirst
      .mockResolvedValueOnce({ id: ID, type: 'EXPENSE' }) // existing
      .mockResolvedValueOnce({ type: 'INCOME' }); // parent — інший тип
    await expect(service.update(ORG, ID, { parentId: PARENT })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('toggleActive: каскад на нащадків (updateMany з [id, ...descendants])', async () => {
    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce({ id: ID }); // existing
    m.prisma.expenseCategory.findMany.mockResolvedValueOnce([{ id: 'child', parentId: ID }]);
    await service.toggleActive(ORG, ID, false);
    expect(m.prisma.expenseCategory.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: [ID, 'child'] }, orgId: ORG }),
        data: { isActive: false },
      }),
    );
  });

  it('remove: каскадний soft-delete нащадків', async () => {
    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce({ id: ID }); // existing
    m.prisma.expenseCategory.findMany.mockResolvedValueOnce([{ id: 'child', parentId: ID }]);
    await service.remove(ORG, ID);
    expect(m.prisma.expenseCategory.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: [ID, 'child'] } }),
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });

  it('remove: неіснуюча → 404', async () => {
    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce(null);
    await expect(service.remove(ORG, ID)).rejects.toThrow(NotFoundException);
  });

  it('restore: активний дубль → 409, updateMany не викликається', async () => {
    m.prisma.expenseCategory.findFirst
      .mockResolvedValueOnce({ name: 'Оренда' })
      .mockResolvedValueOnce({ id: 'active-dup' });
    await expect(service.restore(ORG, ID)).rejects.toThrow(ConflictException);
    expect(m.prisma.expenseCategory.updateMany).not.toHaveBeenCalled();
  });

  // Bug #734: батько soft-deleted → відновлення нащадка піднімає його до кореня (не сирота).
  it('restore: батько видалений → нащадок стає коренем (parentId=null)', async () => {
    m.prisma.expenseCategory.findFirst
      .mockResolvedValueOnce({ name: 'Оренда', parentId: PARENT }) // deleted node has parent
      .mockResolvedValueOnce(null) // active-duplicate check → none
      .mockResolvedValueOnce(null); // parentAlive check → parent НЕ живий
    await service.restore(ORG, ID);
    expect(m.prisma.expenseCategory.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: ID, orgId: ORG }),
        data: expect.objectContaining({ deletedAt: null, parentId: null }),
      }),
    );
  });

  // Bug #734: батько живий → нащадок відновлюється БЕЗ зміни parentId.
  it('restore: батько живий → parentId зберігається', async () => {
    m.prisma.expenseCategory.findFirst
      .mockResolvedValueOnce({ name: 'Оренда', parentId: PARENT })
      .mockResolvedValueOnce(null) // active-dup
      .mockResolvedValueOnce({ id: PARENT }); // parentAlive → живий
    await service.restore(ORG, ID);
    const call = m.prisma.expenseCategory.updateMany.mock.calls[0][0];
    expect(call.data).not.toHaveProperty('parentId');
    expect(call.data).toEqual(expect.objectContaining({ deletedAt: null }));
  });

  // Bug #736: create дитини на 3-му рівні (глибина батька=2) → 400.
  it('create: перевищення MAX_DEPTH → 400', async () => {
    m.prisma.expenseCategory.findFirst.mockResolvedValueOnce({ type: 'EXPENSE' }); // parent lookup
    // getDepth: батько PARENT має ланцюг GP→ROOT → глибина 2.
    m.prisma.expenseCategory.findMany.mockResolvedValueOnce([
      { id: PARENT, parentId: 'gp' },
      { id: 'gp', parentId: 'root' },
      { id: 'root', parentId: null },
    ]);
    await expect(service.create(ORG, { name: 'X', parentId: PARENT })).rejects.toThrow(
      BadRequestException,
    );
    expect(m.prisma.expenseCategory.create).not.toHaveBeenCalled();
  });

  it('findAll: cache hit → БД не чіпається', async () => {
    const cached = { items: [], total: 0 };
    m.cache.get.mockResolvedValueOnce(cached);
    const res = await service.findAll(ORG);
    expect(res).toBe(cached);
    expect(m.prisma.expenseCategory.findMany).not.toHaveBeenCalled();
  });

  it('findAll: будує дерево (діти вкладені у батька)', async () => {
    m.cache.get.mockResolvedValueOnce(null);
    m.prisma.expenseCategory.findMany.mockResolvedValueOnce([
      row({ id: PARENT, parentId: null, name: 'Витрати' }),
      row({ id: 'c1', parentId: PARENT, name: 'Оренда' }),
    ]);
    const res = await service.findAll(ORG);
    expect(res.items).toHaveLength(1); // лише корінь
    expect(res.items[0].id).toBe(PARENT);
    expect(res.items[0].children).toHaveLength(1);
    expect(res.items[0].children[0].id).toBe('c1');
  });
});
