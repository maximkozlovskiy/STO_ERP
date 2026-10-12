/**
 * Ціноутворення: вибір правила для товару й розрахунок ціни.
 *
 * BR-GOOD-009 — правило націлюється на список товарів; BR-GOOD-010 — категорія з довідника діє
 * на себе й усі підкатегорії, ближча до товару категорія перемагає.
 *
 * Mutation-verify (резолвер):
 *  · рівень «товар у списку» поставити після бренду → кейс про ієрархію падає;
 *  · `open = rules.filter(r => !hasGoods(r))` → `rules` → кейс «правило зі списком не діє на
 *    товар поза списком» падає;
 *  · `categoryChain` повертає лише саму категорію → кейс про підкатегорію падає;
 *  · обхід ланцюжка від кореня (reverse) → кейс «ближча категорія перемагає» падає;
 *  · прибрати `seen` у `categoryChain` → кейс про цикл зависає (таймаут);
 *  · текстову категорію перевіряти перед довідниковою → кейс про порядок падає;
 *  · `loadGoodLinks` без `goodId: { in }` → кейс «зв'язки лише для запитаних товарів» падає;
 *  · `withDescendants` без нащадків → кейс «Застосувати до всіх: категорія з підкатегоріями» падає.
 */
import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  PricingService,
  type PricingContext,
  type PricingGood,
  type RuleEntry,
} from './pricing.service';
import { PrismaService } from '../../prisma/prisma.service';

type RuleTier = {
  costMin: number;
  costMax: number | null;
  percentValue: number;
  sortOrder: number;
};

/** Тестове правило: грошові поля числами (у проді — Prisma `Decimal`, тип `unknown`). */
type Rule = Omit<RuleEntry, 'tiers' | '_count'> & { tiers: RuleTier[]; goods?: string[] };

const makeRule = (overrides: Partial<Rule> = {}): Rule => ({
  id: 'r',
  name: 'r',
  goodCategory: null,
  goodCategoryId: null,
  goodType: null,
  brandId: null,
  supplierId: null,
  type: 'PERCENT',
  percentValue: 30,
  fixedAmount: null,
  fixedPrice: null,
  roundTo: null,
  tiers: [],
  ...overrides,
});

/**
 * Контекст із правил (у порядку пріоритету, як їх віддає база). `goods` у правилі — його список
 * товарів; `parents` — дерево категорій «дитина → батько».
 */
function ctxOf(rules: Rule[], parents: Record<string, string | null> = {}): PricingContext {
  const ruleIdsByGood = new Map<string, Set<string>>();
  for (const r of rules) {
    for (const goodId of r.goods ?? []) {
      const set = ruleIdsByGood.get(goodId) ?? new Set<string>();
      set.add(r.id);
      ruleIdsByGood.set(goodId, set);
    }
  }
  return {
    rules: rules.map(({ goods, ...r }) => ({ ...r, _count: { goods: goods?.length ?? 0 } })),
    ruleIdsByGood,
    categoryParent: new Map(Object.entries(parents)),
  };
}

const good = (overrides: Partial<PricingGood> = {}): PricingGood => ({
  id: 'g1',
  goodCategoryId: null,
  category: null,
  goodType: null,
  brandId: null,
  ...overrides,
});

describe('PricingService.computePriceFromRules — формула ціни', () => {
  // Чиста функція (без БД) — Prisma не потрібна.
  const service = new PricingService({} as unknown as PrismaService);
  const price = (rule: Partial<Rule>, cost: number) =>
    service.computePriceFromRules(ctxOf([makeRule(rule)]), good(), cost);

  it('правил немає → повертає costPrice', () => {
    expect(service.computePriceFromRules(ctxOf([]), good(), 100)).toBe(100);
  });

  it('PERCENT: cost * (1 + p/100)', () => {
    expect(price({ type: 'PERCENT', percentValue: 40 }, 100)).toBeCloseTo(140);
  });

  it('COMPETITOR_PLUS працює як PERCENT', () => {
    expect(price({ type: 'COMPETITOR_PLUS', percentValue: 15 }, 200)).toBeCloseTo(230);
  });

  it('FIXED_AMOUNT: cost + надбавка', () => {
    expect(price({ type: 'FIXED_AMOUNT', fixedAmount: 75 }, 100)).toBe(175);
  });

  it('FIXED_PRICE: ігнорує cost, повертає fixedPrice', () => {
    expect(price({ type: 'FIXED_PRICE', fixedPrice: 999 }, 100)).toBe(999);
  });

  it('roundTo: округлення до найближчого кратного', () => {
    // 100 * 1.33 = 133 → round(133/10)*10 = 130
    expect(price({ type: 'PERCENT', percentValue: 33, roundTo: 10 }, 100)).toBe(130);
  });

  it("захист від від'ємної ціни — Math.max(0, result)", () => {
    expect(price({ type: 'FIXED_AMOUNT', fixedAmount: 0 }, -50)).toBe(0);
  });

  describe('COST_TIER', () => {
    const tiers: RuleTier[] = [
      { costMin: 0, costMax: 100, percentValue: 30, sortOrder: 0 },
      { costMin: 100, costMax: 500, percentValue: 20, sortOrder: 1 },
      { costMin: 500, costMax: null, percentValue: 10, sortOrder: 2 },
    ];
    const tierPrice = (cost: number, list: RuleTier[] = tiers) =>
      price({ type: 'COST_TIER', tiers: list }, cost);

    it('cost у першому тірі', () => {
      expect(tierPrice(50)).toBeCloseTo(65); // 50 * 1.30
    });

    it('cost у другому тірі', () => {
      expect(tierPrice(200)).toBeCloseTo(240); // 200 * 1.20
    });

    it('cost в останньому тірі (costMax null — верхня межа відкрита)', () => {
      expect(tierPrice(1000)).toBeCloseTo(1100); // 1000 * 1.10
    });

    it('cost точно на верхній межі тіру → наступний тір (верхня межа не включена)', () => {
      expect(tierPrice(100)).toBeCloseTo(120);
    });

    it('cost точно дорівнює costMin → тір застосовується (нижня межа включена)', () => {
      expect(tierPrice(500)).toBeCloseTo(550);
    });

    it('cost = 0 → тір [0, 100) застосовується, ціна 0', () => {
      expect(tierPrice(0)).toBe(0);
    });

    it('cost не покритий жодним тіром → повертає costPrice', () => {
      expect(tierPrice(50, [{ costMin: 500, costMax: 1000, percentValue: 20, sortOrder: 0 }])).toBe(
        50,
      );
    });

    it('tiers = [] → повертає costPrice без націнки', () => {
      expect(tierPrice(50, [])).toBe(50);
    });
  });
});

describe('PricingService.resolveRule — яке правило діє на товар', () => {
  const service = new PricingService({} as unknown as PrismaService);
  const ruleFor = (rules: Rule[], g: PricingGood, parents = {}, supplierId?: string) =>
    service.resolveRule(ctxOf(rules, parents), g, 100, supplierId).ruleName;

  // guards: BR-GOOD-009
  it('ієрархія: список товарів > бренд > категорія > тип > весь асортимент', () => {
    const all = makeRule({ id: 'all', name: 'all' });
    const type = makeRule({ id: 'type', name: 'type', goodType: 'SPARE_PART' });
    const category = makeRule({ id: 'cat', name: 'cat', goodCategoryId: 'c1' });
    const brand = makeRule({ id: 'brand', name: 'brand', brandId: 'b1' });
    const list = makeRule({ id: 'list', name: 'list', goods: ['g1'] });
    const g = good({ goodCategoryId: 'c1', goodType: 'SPARE_PART', brandId: 'b1' });
    const parents = { c1: null };

    // Порядок у масиві навмисно «від загального»: рівень важить більше за пріоритет.
    expect(ruleFor([all, type, category, brand, list], g, parents)).toBe('list');
    expect(ruleFor([all, type, category, brand], g, parents)).toBe('brand');
    expect(ruleFor([all, type, category], g, parents)).toBe('cat');
    expect(ruleFor([all, type], g, parents)).toBe('type');
    expect(ruleFor([all], g, parents)).toBe('all');
  });

  // guards: BR-GOOD-009
  it('правило зі списком НЕ діє на товар поза списком — воно не «весь асортимент»', () => {
    const list = makeRule({ id: 'list', name: 'list', goods: ['other'] });
    expect(ruleFor([list], good())).toBeNull();
    expect(service.computePriceFromRules(ctxOf([list]), good(), 100)).toBe(100);
  });

  // guards: BR-GOOD-009
  it('товар у списках двох правил → перемагає правило з вищим пріоритетом (перше в контексті)', () => {
    const first = makeRule({ id: 'p1', name: 'p1', goods: ['g1'] });
    const second = makeRule({ id: 'p2', name: 'p2', goods: ['g1', 'g2'] });
    expect(ruleFor([first, second], good())).toBe('p1');
    expect(ruleFor([first, second], good({ id: 'g2' }))).toBe('p2');
  });

  // guards: BR-GOOD-010
  it('категорія правила діє на товари підкатегорій будь-якої глибини', () => {
    const brakes = makeRule({ id: 'brakes', name: 'brakes', goodCategoryId: 'brakes' });
    const parents = { brakes: null, pads: 'brakes', ceramic: 'pads', oils: null };
    expect(ruleFor([brakes], good({ goodCategoryId: 'brakes' }), parents)).toBe('brakes');
    expect(ruleFor([brakes], good({ goodCategoryId: 'pads' }), parents)).toBe('brakes');
    expect(ruleFor([brakes], good({ goodCategoryId: 'ceramic' }), parents)).toBe('brakes');
    // Сусідня гілка і товар без категорії під правило не потрапляють.
    expect(ruleFor([brakes], good({ goodCategoryId: 'oils' }), parents)).toBeNull();
    expect(ruleFor([brakes], good(), parents)).toBeNull();
  });

  // guards: BR-GOOD-010
  it('ближча категорія перемагає дальшу, навіть якщо в дальшої вищий пріоритет', () => {
    const parents = { brakes: null, pads: 'brakes', ceramic: 'pads' };
    // Правило кореня стоїть ПЕРШИМ (вищий пріоритет) — і все одно програє ближчому.
    const root = makeRule({ id: 'root', name: 'root', goodCategoryId: 'brakes' });
    const near = makeRule({ id: 'near', name: 'near', goodCategoryId: 'pads' });
    expect(ruleFor([root, near], good({ goodCategoryId: 'ceramic' }), parents)).toBe('near');
    expect(ruleFor([root, near], good({ goodCategoryId: 'pads' }), parents)).toBe('near');
    expect(ruleFor([root, near], good({ goodCategoryId: 'brakes' }), parents)).toBe('root');
  });

  // guards: BR-GOOD-010
  it('два правила однієї категорії → вищий пріоритет (перше в контексті)', () => {
    const a = makeRule({ id: 'a', name: 'a', goodCategoryId: 'c1' });
    const b = makeRule({ id: 'b', name: 'b', goodCategoryId: 'c1' });
    expect(ruleFor([a, b], good({ goodCategoryId: 'c1' }), { c1: null })).toBe('a');
  });

  // guards: BR-GOOD-010
  it('цикл у дереві категорій не зациклює пошук', () => {
    const rule = makeRule({ id: 'x', name: 'x', goodCategoryId: 'zzz' });
    const parents = { a: 'b', b: 'a' };
    expect(ruleFor([rule], good({ goodCategoryId: 'a' }), parents)).toBeNull();
  });

  // guards: BR-GOOD-010
  it('старе правило з текстовою категорією діє за текстом картки, але після довідникових', () => {
    const legacy = makeRule({ id: 'legacy', name: 'legacy', goodCategory: 'Мастила' });
    const dictionary = makeRule({ id: 'dict', name: 'dict', goodCategoryId: 'oils' });
    const g = good({ category: 'Мастила', goodCategoryId: 'oils' });
    expect(ruleFor([legacy], g, { oils: null })).toBe('legacy');
    expect(ruleFor([legacy, dictionary], g, { oils: null })).toBe('dict');
    // Текст порівнюється точно, як і раніше.
    expect(ruleFor([legacy], good({ category: 'мастила' }))).toBeNull();
  });

  it('бренд сильніший за тип; правило бренду не діє на товар іншого бренду', () => {
    const type = makeRule({ id: 'type', name: 'type', goodType: 'SPARE_PART' });
    const brand = makeRule({ id: 'brand', name: 'brand', brandId: 'b1' });
    expect(ruleFor([type, brand], good({ goodType: 'SPARE_PART', brandId: 'b1' }))).toBe('brand');
    expect(ruleFor([type, brand], good({ goodType: 'SPARE_PART', brandId: 'b2' }))).toBe('type');
    expect(ruleFor([brand], good())).toBeNull();
  });

  it('правило типу не діє на товар іншого типу; правило категорії — не «весь асортимент»', () => {
    const type = makeRule({ id: 'type', name: 'type', goodType: 'SPARE_PART' });
    const category = makeRule({ id: 'cat', name: 'cat', goodCategoryId: 'c1' });
    expect(ruleFor([type, category], good({ goodType: 'CONSUMABLE' }), { c1: null })).toBeNull();
  });

  it('правило постачальника перемагає всі інші, але лише для свого постачальника', () => {
    const supplier = makeRule({ id: 'sup', name: 'sup', supplierId: 's1' });
    const list = makeRule({ id: 'list', name: 'list', goods: ['g1'] });
    expect(ruleFor([list, supplier], good(), {}, 's1')).toBe('sup');
    expect(ruleFor([list, supplier], good(), {}, 's2')).toBe('list');
    // Без постачальника правило постачальника не стає загальним.
    expect(ruleFor([supplier], good())).toBeNull();
  });
});

describe('PricingService.getPricingContext', () => {
  let service: PricingService;
  let prisma: {
    pricingRule: { findMany: ReturnType<typeof vi.fn> };
    pricingRuleGood: { findMany: ReturnType<typeof vi.fn> };
    goodCategory: { findMany: ReturnType<typeof vi.fn> };
  };
  const dbRule = (patch: Record<string, unknown> = {}) => ({
    ...makeRule(),
    _count: { goods: 0 },
    ...patch,
  });

  beforeEach(async () => {
    prisma = {
      pricingRule: { findMany: vi.fn().mockResolvedValue([]) },
      pricingRuleGood: { findMany: vi.fn().mockResolvedValue([]) },
      goodCategory: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const module = await Test.createTestingModule({
      providers: [PricingService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(PricingService);
  });

  it('читає активні невидалені правила організації за пріоритетом, з тірами й лічильником списку', async () => {
    await service.getPricingContext('org-X', ['g1']);
    expect(prisma.pricingRule.findMany).toHaveBeenCalledWith({
      where: { orgId: 'org-X', isActive: true, deletedAt: null },
      include: {
        tiers: { orderBy: { sortOrder: 'asc' } },
        _count: { select: { goods: true } },
      },
      orderBy: { priority: 'asc' },
      take: 200,
    });
  });

  it('жодне правило не має списку й категорії → зайвих запитів немає', async () => {
    prisma.pricingRule.findMany.mockResolvedValueOnce([dbRule()]);
    const ctx = await service.getPricingContext('org-X', ['g1']);
    expect(prisma.pricingRuleGood.findMany).not.toHaveBeenCalled();
    expect(prisma.goodCategory.findMany).not.toHaveBeenCalled();
    expect(ctx.ruleIdsByGood.size).toBe(0);
    expect(ctx.categoryParent.size).toBe(0);
  });

  // guards: BR-GOOD-009
  it('зв’язки списків читаються лише для запитаних товарів і лише правил зі списком', async () => {
    prisma.pricingRule.findMany.mockResolvedValueOnce([
      dbRule({ id: 'list', _count: { goods: 4000 } }),
      dbRule({ id: 'plain' }),
    ]);
    prisma.pricingRuleGood.findMany.mockResolvedValueOnce([
      { pricingRuleId: 'list', goodId: 'g1' },
    ]);
    const ctx = await service.getPricingContext('org-X', ['g1', 'g2', 'g1']);
    expect(prisma.pricingRuleGood.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.pricingRuleGood.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orgId: 'org-X', pricingRuleId: { in: ['list'] }, goodId: { in: ['g1', 'g2'] } },
      }),
    );
    expect(ctx.ruleIdsByGood.get('g1')).toEqual(new Set(['list']));
    expect(ctx.ruleIdsByGood.has('g2')).toBe(false);
  });

  // guards: BR-GOOD-010
  it('дерево категорій читається, коли хоч одне правило має категорію з довідника', async () => {
    prisma.pricingRule.findMany.mockResolvedValueOnce([dbRule({ goodCategoryId: 'c1' })]);
    prisma.goodCategory.findMany.mockResolvedValueOnce([
      { id: 'c1', parentId: null },
      { id: 'c2', parentId: 'c1' },
    ]);
    const ctx = await service.getPricingContext('org-X', []);
    expect(prisma.goodCategory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: 'org-X', deletedAt: null } }),
    );
    expect(ctx.categoryParent.get('c2')).toBe('c1');
    expect(ctx.categoryParent.get('c1')).toBeNull();
  });

  it('onlyRuleId лишає в контексті одне правило (розцінка закупівлі обраним правилом)', async () => {
    prisma.pricingRule.findMany.mockResolvedValueOnce([dbRule({ id: 'a' }), dbRule({ id: 'b' })]);
    const ctx = await service.getPricingContext('org-X', [], { onlyRuleId: 'b' });
    expect(ctx.rules.map(r => r.id)).toEqual(['b']);
  });
});

describe('PricingService.applyRuleToGoods', () => {
  let service: PricingService;
  let prisma: {
    pricingRule: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
    pricingRuleGood: { findMany: ReturnType<typeof vi.fn> };
    goodCategory: { findMany: ReturnType<typeof vi.fn> };
    good: {
      findMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    priceHistory: { create: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };

  /** Правило, як його читає applyRuleToGoods (з лічильником списку). */
  const targetRule = (patch: Record<string, unknown> = {}) => ({
    id: 'r1',
    orgId: 'org',
    name: 'PERCENT 35',
    type: 'PERCENT',
    percentValue: 35,
    goodCategory: null,
    goodCategoryId: null,
    goodType: null,
    brandId: null,
    _count: { goods: 0 },
    ...patch,
  });
  const activeRule = (patch: Record<string, unknown> = {}) => ({
    ...makeRule({ percentValue: 35 }),
    _count: { goods: 0 },
    ...patch,
  });
  const goodRow = (id: string, salePrice: number, patch: Record<string, unknown> = {}) => ({
    id,
    purchasePrice: 100,
    salePrice,
    category: null,
    goodCategoryId: null,
    goodType: null,
    brandId: null,
    ...patch,
  });
  const goodsWhere = () => prisma.good.findMany.mock.calls[0]![0].where as Record<string, unknown>;

  beforeEach(async () => {
    prisma = {
      pricingRule: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn() },
      pricingRuleGood: { findMany: vi.fn().mockResolvedValue([]) },
      goodCategory: { findMany: vi.fn().mockResolvedValue([]) },
      good: {
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue({}),
        // Bug #489: applyRuleToGoods використовує tx.good.updateMany (з orgId guard, не update).
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      priceHistory: {
        create: vi.fn().mockResolvedValue({}),
        createMany: vi.fn().mockResolvedValue({}),
      },
      // Bug #489: callback-форма $transaction мусить реально викликати callback, інакше
      // внутрішня логіка (updateMany з orgId) у тестах не виконується.
      $transaction: vi.fn().mockImplementation((arg: unknown) => {
        if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
        if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
        return Promise.resolve(arg);
      }),
    };
    const module = await Test.createTestingModule({
      providers: [PricingService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(PricingService);
  });

  it('повертає 0 якщо rule не знайдено', async () => {
    prisma.pricingRule.findFirst.mockResolvedValue(null);
    expect(await service.applyRuleToGoods('org', 'missing')).toBe(0);
  });

  it('перераховує тільки ті товари, де ціна змінилась', async () => {
    prisma.pricingRule.findFirst.mockResolvedValue(targetRule());
    prisma.pricingRule.findMany.mockResolvedValue([activeRule()]);
    prisma.good.findMany.mockResolvedValue([goodRow('g1', 135), goodRow('g2', 100)]);
    expect(await service.applyRuleToGoods('org', 'r1')).toBe(1); // лише g2
  });

  // Bug #178 (аудит 2026-09-04): область — ОДИН найточніший вимір, а не AND усіх полів.
  // Раніше комбіноване правило «бренд + категорія» не перераховувало товари бренду поза категорією.
  it('Bug #178: правило з брендом і категорією відбирає товари за брендом, без AND категорії', async () => {
    prisma.pricingRule.findFirst.mockResolvedValue(
      targetRule({ brandId: 'b1', goodCategory: 'BRAKES', goodCategoryId: 'c1' }),
    );
    await service.applyRuleToGoods('org', 'r1');
    const where = goodsWhere();
    expect(where.brandId).toBe('b1');
    expect(where).not.toHaveProperty('category');
    expect(where).not.toHaveProperty('goodCategoryId');
    expect(where).not.toHaveProperty('goodType');
    expect(where.orgId).toBe('org');
    expect(where.deletedAt).toBeNull();
  });

  // guards: BR-GOOD-009
  it('правило зі списком: відбирає товари списку, а не весь асортимент', async () => {
    prisma.pricingRule.findFirst.mockResolvedValue(
      targetRule({ brandId: 'b1', _count: { goods: 2 } }),
    );
    await service.applyRuleToGoods('org', 'r1');
    const where = goodsWhere();
    expect(where.pricingRuleLinks).toEqual({ some: { pricingRuleId: 'r1' } });
    expect(where).not.toHaveProperty('brandId');
    expect(where.orgId).toBe('org');
  });

  // guards: BR-GOOD-010
  it('правило категорії: відбирає товари категорії з усіма підкатегоріями', async () => {
    prisma.pricingRule.findFirst.mockResolvedValue(targetRule({ goodCategoryId: 'brakes' }));
    prisma.goodCategory.findMany.mockResolvedValue([
      { id: 'brakes', parentId: null },
      { id: 'pads', parentId: 'brakes' },
      { id: 'ceramic', parentId: 'pads' },
      { id: 'oils', parentId: null },
    ]);
    await service.applyRuleToGoods('org', 'r1');
    const filter = goodsWhere().goodCategoryId as { in: string[] };
    expect([...filter.in].sort()).toEqual(['brakes', 'ceramic', 'pads']);
  });

  // guards: BR-GOOD-010
  it('старе правило з текстовою категорією відбирає товари за текстом картки', async () => {
    prisma.pricingRule.findFirst.mockResolvedValue(targetRule({ goodCategory: 'Мастила' }));
    await service.applyRuleToGoods('org', 'r1');
    expect(goodsWhere().category).toBe('Мастила');
  });

  // guards: BR-GOOD-009
  it('товар списку розцінюється правилом списку, а не загальним правилом з вищим пріоритетом', async () => {
    prisma.pricingRule.findFirst.mockResolvedValue(targetRule({ _count: { goods: 1 } }));
    prisma.good.findMany.mockResolvedValue([goodRow('g1', 100)]);
    prisma.pricingRule.findMany.mockResolvedValue([
      activeRule({ id: 'all', percentValue: 10 }),
      activeRule({ id: 'r1', percentValue: 35, _count: { goods: 1 } }),
    ]);
    prisma.pricingRuleGood.findMany.mockResolvedValue([{ pricingRuleId: 'r1', goodId: 'g1' }]);
    expect(await service.applyRuleToGoods('org', 'r1')).toBe(1);
    expect(prisma.good.updateMany).toHaveBeenCalledWith({
      where: { id: 'g1', orgId: 'org', deletedAt: null },
      data: { salePrice: 135 },
    });
  });

  // Bug #489 + #491: defense-in-depth tenant isolation — updateMany з orgId/deletedAt:null.
  it('Bug #489: пише ціну через updateMany з orgId/deletedAt:null і лишає запис в історії цін', async () => {
    prisma.pricingRule.findFirst.mockResolvedValue(targetRule());
    prisma.pricingRule.findMany.mockResolvedValue([activeRule()]);
    prisma.good.findMany.mockResolvedValue([goodRow('g-target', 100)]);

    expect(await service.applyRuleToGoods('org', 'r1')).toBe(1);
    expect(prisma.good.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.good.updateMany).toHaveBeenCalledWith({
      where: { id: 'g-target', orgId: 'org', deletedAt: null },
      data: { salePrice: 135 },
    });
    expect(prisma.priceHistory.createMany).toHaveBeenCalledTimes(1);
  });
});
