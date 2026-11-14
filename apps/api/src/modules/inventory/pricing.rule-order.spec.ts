/**
 * BR-GOOD-012, блок 4 (№15, рішення власника 2026-10-30): рівний `priority` — перемагає вище в
 * списку правило, тобто новіше. Список правил на сторінці і вибір переможця розцінки — ОДИН
 * порядок `priority asc, createdAt desc, id asc`. До 2026-11-14 список показував новіше першим,
 * а розцінка брала старше: користувач бачив угорі одне правило, а ціну давало інше.
 *
 * Підробка Prisma ВИКОНУЄ `where` і СОРТУЄ за переданим `orderBy` (зокрема курсор сторінок) —
 * тест бачить реальний порядок обох запитів, а не заготовку.
 *
 * Mutation-verify (2026-11-14):
 *  · `createdAt: 'asc'` у `PRICING_RULE_ORDER` → кейси «рівний priority» падають;
 *  · `getPricingContext` з власним `orderBy` `createdAt: 'asc'` (як було) → кейс «список і
 *    переможець — одне правило» падає.
 */
import { describe, it, expect, vi } from 'vitest';
import { PRICING_RULE_ORDER, PricingService } from './pricing.service';
import { PricingRulesService } from './pricing-rules.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';

const ORG = 'org-1';

interface RuleRow {
  id: string;
  orgId: string;
  name: string;
  priority: number;
  createdAt: Date;
  isActive: boolean;
  deletedAt: Date | null;
  supplierId: string | null;
}

type Order = Array<Record<string, 'asc' | 'desc'>>;

/** Prisma `orderBy` масивом ключів над рядками в пам'яті. */
function sortBy(rows: RuleRow[], orderBy: Order): RuleRow[] {
  return [...rows].sort((a, b) => {
    for (const key of orderBy) {
      const [field, dir] = Object.entries(key)[0]!;
      const av = a[field as keyof RuleRow] as number | string | Date;
      const bv = b[field as keyof RuleRow] as number | string | Date;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      if (cmp !== 0) return dir === 'asc' ? cmp : -cmp;
    }
    return 0;
  });
}

function makeServices(rules: RuleRow[]) {
  const findMany = vi.fn(
    (args: {
      where: Partial<RuleRow>;
      orderBy: Order;
      take: number;
      skip?: number;
      cursor?: { id: string };
    }) => {
      const w = args.where;
      const hit = rules.filter(
        r =>
          r.orgId === w.orgId &&
          (w.deletedAt !== null || r.deletedAt === null) &&
          (w.isActive === undefined || r.isActive === w.isActive),
      );
      const sorted = sortBy(hit, args.orderBy);
      const from = args.cursor ? sorted.findIndex(r => r.id === args.cursor!.id) + 1 : 0;
      return Promise.resolve(
        sorted.slice(from, from + args.take).map(r => ({
          ...r,
          type: 'PERCENT',
          percentValue: 10,
          fixedAmount: null,
          fixedPrice: null,
          roundTo: null,
          goodCategory: null,
          goodCategoryId: null,
          goodType: null,
          brandId: null,
          category: null,
          brand: null,
          supplier: null,
          tiers: [],
          goods: [],
          _count: { goods: 0 },
        })),
      );
    },
  );
  const prisma = {
    pricingRule: { findMany },
    pricingRuleGood: { groupBy: vi.fn().mockResolvedValue([]), findMany: vi.fn() },
    goodCategory: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const pricing = new PricingService(prisma as unknown as PrismaService);
  const rulesService = new PricingRulesService(
    pricing,
    prisma as unknown as PrismaService,
    { record: vi.fn() } as unknown as AuditService,
  );
  return { pricing, rulesService, findMany };
}

const rule = (id: string, priority: number, createdAt: string, extra: Partial<RuleRow> = {}) => ({
  id,
  orgId: ORG,
  name: id,
  priority,
  createdAt: new Date(createdAt),
  isActive: true,
  deletedAt: null,
  supplierId: null,
  ...extra,
});

const GOOD = {
  id: 'g-1',
  category: null,
  goodCategoryId: null,
  goodType: null,
  brandId: null,
};

// guards: BR-GOOD-012
describe('Порядок правил ціни — один для списку й для розцінки (№15)', () => {
  it('обидва запити беруть той самий порядок: priority ↑, createdAt ↓, id ↑', async () => {
    const { pricing, rulesService, findMany } = makeServices([]);
    await rulesService.findAll(ORG);
    await pricing.getPricingContext(ORG, ['g-1']);

    expect(PRICING_RULE_ORDER).toEqual([{ priority: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }]);
    expect(findMany.mock.calls.map(c => c[0].orderBy)).toEqual([
      PRICING_RULE_ORDER,
      PRICING_RULE_ORDER,
    ]);
  });

  it('рівний priority: перше в списку — новіше правило, і саме воно дає ціну', async () => {
    const { pricing, rulesService } = makeServices([
      rule('old', 10, '2026-01-01T00:00:00Z'),
      rule('new', 10, '2026-06-01T00:00:00Z'),
    ]);

    const list = await rulesService.findAll(ORG);
    const ctx = await pricing.getPricingContext(ORG, ['g-1']);
    const winner = pricing.resolveRule(ctx, GOOD, 100);

    expect(list.items.map(r => r.id)).toEqual(['new', 'old']);
    expect(winner.ruleName).toBe(list.items[0]!.name);
    expect(winner.ruleName).toBe('new');
  });

  it('менше число priority перемагає незалежно від дати створення', async () => {
    const { pricing, rulesService } = makeServices([
      rule('newer-low', 20, '2026-06-01T00:00:00Z'),
      rule('older-high', 5, '2026-01-01T00:00:00Z'),
    ]);

    const list = await rulesService.findAll(ORG);
    const ctx = await pricing.getPricingContext(ORG, ['g-1']);

    expect(list.items.map(r => r.id)).toEqual(['older-high', 'newer-low']);
    expect(pricing.resolveRule(ctx, GOOD, 100).ruleName).toBe('older-high');
  });

  it('рівні priority і момент створення — id розсуджує однаково в обох місцях', async () => {
    const { pricing, rulesService } = makeServices([
      rule('b', 10, '2026-06-01T00:00:00Z'),
      rule('a', 10, '2026-06-01T00:00:00Z'),
    ]);

    const list = await rulesService.findAll(ORG);
    const ctx = await pricing.getPricingContext(ORG, ['g-1']);

    expect(list.items.map(r => r.id)).toEqual(['a', 'b']);
    expect(pricing.resolveRule(ctx, GOOD, 100).ruleName).toBe('a');
  });

  it('вимкнене новіше правило у списку вище, але ціни не дає — переможець наступний активний', async () => {
    const { pricing, rulesService } = makeServices([
      rule('old', 10, '2026-01-01T00:00:00Z'),
      rule('new-off', 10, '2026-06-01T00:00:00Z', { isActive: false }),
    ]);

    const list = await rulesService.findAll(ORG);
    const ctx = await pricing.getPricingContext(ORG, ['g-1']);

    expect(list.items.map(r => r.id)).toEqual(['new-off', 'old']);
    expect(pricing.resolveRule(ctx, GOOD, 100).ruleName).toBe('old');
  });
});
