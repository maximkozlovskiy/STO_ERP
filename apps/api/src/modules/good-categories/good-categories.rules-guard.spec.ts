/**
 * BR-GOOD-010, блок 4 (№14, рішення власника 2026-10-30): категорію товарів, на яку чи на чиїх
 * нащадків посилаються живі правила ціни, не видалити — 400 з назвами правил, до будь-якого запису.
 * Раніше категорія видалялась, а правило лишалось із мертвим `goodCategoryId` і мовчки
 * переставало діяти на товари цієї категорії.
 *
 * Підробка Prisma ВИКОНУЄ `where` правил (orgId, deletedAt, goodCategoryId in) — забутий фільтр
 * змінює результат, а не проходить на заготовці.
 *
 * Mutation-verify (2026-11-14):
 *  · прибрати виклик `assertNotUsedByRules` → кейси «правило на категорії / нащадку» падають;
 *  · `goodCategoryId: { in: categoryIds }` → лише `id` категорії → кейс про нащадка падає;
 *  · прибрати `deletedAt: null` → кейс «видалене правило не заважає» падає;
 *  · прибрати `orgId` → кейс «правило іншої організації» падає.
 */
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { GoodCategoriesService } from './good-categories.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CacheService } from '../../redis/cache.service';

const ORG = 'org-1';
const OTHER_ORG = 'org-2';

interface Category {
  id: string;
  parentId: string | null;
  isSystem?: boolean;
}
interface Rule {
  name: string;
  orgId?: string;
  goodCategoryId: string | null;
  deleted?: boolean;
  isActive?: boolean;
}

type Where = { orgId?: string; deletedAt?: null; goodCategoryId?: { in: string[] } };

function makeWorld(categories: Category[], rules: Rule[]) {
  const ruleMatches = (r: Rule, where: Where) =>
    (where.orgId === undefined || (r.orgId ?? ORG) === where.orgId) &&
    (where.deletedAt !== null || !r.deleted) &&
    (!where.goodCategoryId || where.goodCategoryId.in.includes(r.goodCategoryId ?? ''));
  const writes: string[] = [];
  const prisma = {
    goodCategory: {
      findFirst: vi.fn(({ where }: { where: { id: string } }) => {
        const c = categories.find(x => x.id === where.id);
        return Promise.resolve(c ? { id: c.id, isSystem: !!c.isSystem } : null);
      }),
      findMany: vi.fn(() => Promise.resolve(categories.map(c => ({ ...c })))),
      updateMany: vi.fn(() => {
        writes.push('goodCategory.updateMany');
        return Promise.resolve({ count: 1 });
      }),
    },
    good: {
      updateMany: vi.fn(() => {
        writes.push('good.updateMany');
        return Promise.resolve({ count: 0 });
      }),
    },
    pricingRule: {
      findMany: vi.fn(({ where, take }: { where: Where; take?: number }) =>
        Promise.resolve(
          rules
            .filter(r => ruleMatches(r, where))
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, take)
            .map(r => ({ name: r.name })),
        ),
      ),
      count: vi.fn(({ where }: { where: Where }) =>
        Promise.resolve(rules.filter(r => ruleMatches(r, where)).length),
      ),
    },
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  const cache = { get: vi.fn(), set: vi.fn(), del: vi.fn() };
  const service = new GoodCategoriesService(
    prisma as unknown as PrismaService,
    cache as unknown as CacheService,
  );
  return { service, writes };
}

const TREE: Category[] = [
  { id: 'oils', parentId: null },
  { id: 'motor', parentId: 'oils' },
  { id: 'synthetic', parentId: 'motor' },
  { id: 'filters', parentId: null },
];

// guards: BR-GOOD-010
describe('GoodCategoriesService.remove — категорію з правилами ціни не видалити (№14)', () => {
  it('правило на самій категорії → 400 з назвою правила, нічого не записано', async () => {
    const w = makeWorld(TREE, [{ name: 'Оливи +20%', goodCategoryId: 'oils' }]);
    const act = w.service.remove(ORG, 'oils');
    await expect(act).rejects.toThrow(BadRequestException);
    await expect(act).rejects.toThrow(
      'Категорію не видалити: її використовують правила ціни — «Оливи +20%». Спершу змініть категорію в правилах',
    );
    expect(w.writes).toEqual([]);
  });

  it('правило на нащадку будь-якої глибини → 400', async () => {
    const w = makeWorld(TREE, [{ name: 'Синтетика', goodCategoryId: 'synthetic' }]);
    await expect(w.service.remove(ORG, 'oils')).rejects.toThrow('«Синтетика»');
    expect(w.writes).toEqual([]);
  });

  it('вимкнене правило теж тримає категорію — воно лишається з цією областю', async () => {
    const w = makeWorld(TREE, [{ name: 'Вимкнене', goodCategoryId: 'motor', isActive: false }]);
    await expect(w.service.remove(ORG, 'motor')).rejects.toThrow('«Вимкнене»');
  });

  it('понад 5 правил — п’ять назв і «і ще N»', async () => {
    const rules = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Є'].map(n => ({
      name: n,
      goodCategoryId: 'oils',
    }));
    const w = makeWorld(TREE, rules);
    await expect(w.service.remove(ORG, 'oils')).rejects.toThrow(
      'правила ціни — «А», «Б», «В», «Г», «Д» і ще 2. Спершу',
    );
  });

  it.each([
    ['видалене правило', { name: 'Старе', goodCategoryId: 'oils', deleted: true }],
    ['правило іншої організації', { name: 'Чуже', goodCategoryId: 'oils', orgId: OTHER_ORG }],
    ['правило іншої гілки дерева', { name: 'Фільтри', goodCategoryId: 'filters' }],
    ['правило без категорії', { name: 'Усе', goodCategoryId: null }],
  ])('%s не заважає — категорія видаляється', async (_name, rule) => {
    const w = makeWorld(TREE, [rule]);
    await expect(w.service.remove(ORG, 'oils')).resolves.toBeUndefined();
    expect(w.writes).toEqual(['good.updateMany', 'goodCategory.updateMany']);
  });
});
