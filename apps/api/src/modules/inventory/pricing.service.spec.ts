import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PricingService } from './pricing.service';
import { PrismaService } from '../../prisma/prisma.service';

type RuleTier = {
  costMin: number;
  costMax: number | null;
  percentValue: number;
  sortOrder: number;
};

type Rule = {
  id: string;
  goodId: string | null;
  goodCategory: string | null;
  goodType: string | null;
  brandId: string | null;
  type: string;
  percentValue: number | null;
  fixedAmount: number | null;
  fixedPrice: number | null;
  roundTo: number | null;
  priority: number;
  isActive: boolean;
  name: string;
  tiers: RuleTier[];
};

describe('PricingService.calculateSalePrice', () => {
  let service: PricingService;
  let prisma: {
    pricingRule: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
    good: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    priceHistory: { create: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    prisma = {
      pricingRule: { findMany: vi.fn(), findFirst: vi.fn() },
      good: { findMany: vi.fn(), update: vi.fn().mockResolvedValue({}) },
      priceHistory: { create: vi.fn().mockResolvedValue({}), createMany: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(async (ops: unknown[]) => ops),
    };
    const module = await Test.createTestingModule({
      providers: [
        PricingService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(PricingService);
  });

  const rule = (overrides: Partial<Rule> = {}): Rule => ({
    id: 'r1', goodId: null, goodCategory: null, goodType: null, brandId: null,
    type: 'PERCENT', percentValue: 30, fixedAmount: null, fixedPrice: null,
    roundTo: null, priority: 10, isActive: true, name: 'r', tiers: [],
    ...overrides,
  });

  it('повертає costPrice якщо правил немає', async () => {
    prisma.pricingRule.findMany.mockResolvedValue([]);
    const price = await service.calculateSalePrice('org', 'g', null, null, null, 100);
    expect(price).toBe(100);
  });

  it('PERCENT правило: cost * (1 + p/100)', async () => {
    prisma.pricingRule.findMany.mockResolvedValue([rule({ type: 'PERCENT', percentValue: 35 })]);
    const price = await service.calculateSalePrice('org', 'g', null, null, null, 200);
    expect(price).toBeCloseTo(270);
  });

  it('FIXED_AMOUNT правило: cost + amount', async () => {
    prisma.pricingRule.findMany.mockResolvedValue([rule({ type: 'FIXED_AMOUNT', fixedAmount: 50 })]);
    const price = await service.calculateSalePrice('org', 'g', null, null, null, 200);
    expect(price).toBe(250);
  });

  it('FIXED_PRICE правило: ігнорує cost', async () => {
    prisma.pricingRule.findMany.mockResolvedValue([rule({ type: 'FIXED_PRICE', fixedPrice: 999 })]);
    const price = await service.calculateSalePrice('org', 'g', null, null, null, 100);
    expect(price).toBe(999);
  });

  it('округлення roundTo', async () => {
    prisma.pricingRule.findMany.mockResolvedValue([rule({ type: 'PERCENT', percentValue: 33, roundTo: 1 })]);
    const price = await service.calculateSalePrice('org', 'g', null, null, null, 100); // 133 → 133
    expect(price).toBe(133);
  });

  it('правило по goodId перекриває загальні', async () => {
    prisma.pricingRule.findMany.mockResolvedValue([
      rule({ id: 'r-specific', goodId: 'g-x', percentValue: 50, priority: 100, tiers: [] }),
      rule({ id: 'r-default', goodId: null, percentValue: 20, priority: 1, tiers: [] }),
    ]);
    const price = await service.calculateSalePrice('org', 'g-x', null, null, null, 100);
    expect(price).toBe(150);
  });

  it('result не може бути від\'ємним', async () => {
    prisma.pricingRule.findMany.mockResolvedValue([rule({ type: 'FIXED_AMOUNT', fixedAmount: 0 })]);
    const price = await service.calculateSalePrice('org', 'g', null, null, null, -50);
    expect(price).toBe(0);
  });

  it('COMPETITOR_PLUS працює як PERCENT', async () => {
    prisma.pricingRule.findMany.mockResolvedValue([rule({ type: 'COMPETITOR_PLUS', percentValue: 10 })]);
    const price = await service.calculateSalePrice('org', 'g', null, null, null, 100);
    expect(price).toBeCloseTo(110);
  });

  it('COST_TIER: cost у першому тірі застосовує відповідний відсоток', async () => {
    const tiers: RuleTier[] = [
      { costMin: 0, costMax: 100, percentValue: 30, sortOrder: 0 },
      { costMin: 100, costMax: 500, percentValue: 20, sortOrder: 1 },
      { costMin: 500, costMax: null, percentValue: 10, sortOrder: 2 },
    ];
    prisma.pricingRule.findMany.mockResolvedValue([rule({ type: 'COST_TIER', tiers })]);
    const price = await service.calculateSalePrice('org', 'g', null, null, null, 50);
    expect(price).toBeCloseTo(65); // 50 * 1.30
  });

  it('COST_TIER: cost у другому тірі', async () => {
    const tiers: RuleTier[] = [
      { costMin: 0, costMax: 100, percentValue: 30, sortOrder: 0 },
      { costMin: 100, costMax: 500, percentValue: 20, sortOrder: 1 },
      { costMin: 500, costMax: null, percentValue: 10, sortOrder: 2 },
    ];
    prisma.pricingRule.findMany.mockResolvedValue([rule({ type: 'COST_TIER', tiers })]);
    const price = await service.calculateSalePrice('org', 'g', null, null, null, 200);
    expect(price).toBeCloseTo(240); // 200 * 1.20
  });

  it('COST_TIER: cost у останньому тірі (costMax null)', async () => {
    const tiers: RuleTier[] = [
      { costMin: 0, costMax: 100, percentValue: 30, sortOrder: 0 },
      { costMin: 500, costMax: null, percentValue: 10, sortOrder: 1 },
    ];
    prisma.pricingRule.findMany.mockResolvedValue([rule({ type: 'COST_TIER', tiers })]);
    const price = await service.calculateSalePrice('org', 'g', null, null, null, 1000);
    expect(price).toBeCloseTo(1100); // 1000 * 1.10
  });

  it('COST_TIER: cost не потрапляє в жоден тір → повертає costPrice', async () => {
    const tiers: RuleTier[] = [
      { costMin: 200, costMax: 500, percentValue: 20, sortOrder: 0 },
    ];
    prisma.pricingRule.findMany.mockResolvedValue([rule({ type: 'COST_TIER', tiers })]);
    const price = await service.calculateSalePrice('org', 'g', null, null, null, 50);
    expect(price).toBe(50); // no matching tier
  });

  it('brandId правило перекриває goodType (пріоритет 2 > 4)', async () => {
    prisma.pricingRule.findMany.mockResolvedValue([
      rule({ id: 'r-brand', brandId: 'b1', goodId: null, percentValue: 25, priority: 5, tiers: [] }),
      rule({ id: 'r-type', goodId: null, goodType: 'SPARE_PART', percentValue: 10, priority: 1, tiers: [] }),
    ]);
    const price = await service.calculateSalePrice('org', 'g', null, 'SPARE_PART', 'b1', 100);
    expect(price).toBeCloseTo(125); // brand rule wins over type rule
  });

  // ── Bug #184: COST_TIER edge cases ────────────────────────────────────────
  it('COST_TIER edge: tiers=[] → повертає costPrice без markup', async () => {
    prisma.pricingRule.findMany.mockResolvedValue([rule({ type: 'COST_TIER', tiers: [] })]);
    const price = await service.calculateSalePrice('org', 'g', null, null, null, 250);
    expect(price).toBe(250);
  });

  it('COST_TIER edge: cost=0 → tier [0,100) застосовує markup → 0', async () => {
    const tiers: RuleTier[] = [
      { costMin: 0, costMax: 100, percentValue: 30, sortOrder: 0 },
    ];
    prisma.pricingRule.findMany.mockResolvedValue([rule({ type: 'COST_TIER', tiers })]);
    const price = await service.calculateSalePrice('org', 'g', null, null, null, 0);
    expect(price).toBe(0); // 0 * (1 + 30/100) = 0
  });

  it('COST_TIER edge: cost точно на верхній межі першого тіру → переходить у наступний', async () => {
    // boundary semantics: half-open [min, max). cost=100 НЕ у [0,100), а у [100,500).
    const tiers: RuleTier[] = [
      { costMin: 0, costMax: 100, percentValue: 30, sortOrder: 0 },
      { costMin: 100, costMax: 500, percentValue: 20, sortOrder: 1 },
    ];
    prisma.pricingRule.findMany.mockResolvedValue([rule({ type: 'COST_TIER', tiers })]);
    const price = await service.calculateSalePrice('org', 'g', null, null, null, 100);
    expect(price).toBeCloseTo(120); // 100 * 1.20 (тір [100,500), не [0,100))
  });

  it('COST_TIER edge: cost точно дорівнює costMin → тір застосовується (нижня межа включена)', async () => {
    const tiers: RuleTier[] = [
      { costMin: 200, costMax: 500, percentValue: 20, sortOrder: 0 },
    ];
    prisma.pricingRule.findMany.mockResolvedValue([rule({ type: 'COST_TIER', tiers })]);
    const price = await service.calculateSalePrice('org', 'g', null, null, null, 200);
    expect(price).toBeCloseTo(240); // 200 у [200,500) — тір застосовується
  });
});

describe('PricingService.applyRuleToGoods', () => {
  let service: PricingService;
  let prisma: {
    pricingRule: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
    good: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    priceHistory: { create: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    prisma = {
      pricingRule: { findMany: vi.fn(), findFirst: vi.fn() },
      good: { findMany: vi.fn(), update: vi.fn().mockResolvedValue({}) },
      priceHistory: { create: vi.fn().mockResolvedValue({}), createMany: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(async (ops: unknown[]) => ops),
    };
    const module = await Test.createTestingModule({
      providers: [
        PricingService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(PricingService);
  });

  it('повертає 0 якщо rule не знайдено', async () => {
    prisma.pricingRule.findFirst.mockResolvedValue(null);
    const result = await service.applyRuleToGoods('org', 'missing');
    expect(result).toBe(0);
  });

  it('перераховує тільки ті товари де ціна змінилась', async () => {
    prisma.pricingRule.findFirst.mockResolvedValue({
      id: 'r1', orgId: 'org', name: 'PERCENT 35',
      type: 'PERCENT', percentValue: 35, goodId: null, goodCategory: null, goodType: null,
    });
    prisma.pricingRule.findMany.mockResolvedValue([{
      goodId: null, goodCategory: null, goodType: null, brandId: null,
      type: 'PERCENT', percentValue: 35, fixedAmount: null, fixedPrice: null, roundTo: null, tiers: [],
    }]);
    prisma.good.findMany.mockResolvedValue([
      { id: 'g1', purchasePrice: 100, salePrice: 135, category: null, goodType: null, brandId: null }, // no change → 135
      { id: 'g2', purchasePrice: 100, salePrice: 100, category: null, goodType: null, brandId: null }, // change → 135
    ]);
    const result = await service.applyRuleToGoods('org', 'r1');
    expect(result).toBe(1); // only g2 changed
  });
});

// Bug #201: regression-захист для нових публічних методів (commit c1dc5dd)
describe('PricingService.computePriceFromRules', () => {
  // Pure-function (no DB) — конструктор Prisma може бути порожнім
  const service = new PricingService({} as unknown as PrismaService);

  const makeRule = (overrides: Partial<Rule> = {}): Rule => ({
    id: 'r', goodId: null, goodCategory: null, goodType: null, brandId: null,
    type: 'PERCENT', percentValue: 30, fixedAmount: null, fixedPrice: null,
    roundTo: null, priority: 10, isActive: true, name: 'r', tiers: [],
    ...overrides,
  });

  it('порожній rules array → повертає costPrice (no-op)', () => {
    const price = service.computePriceFromRules([], 'g1', undefined, undefined, undefined, 100);
    expect(price).toBe(100);
  });

  it('PERCENT правило: cost * (1 + p/100)', () => {
    const rules = [makeRule({ type: 'PERCENT', percentValue: 40 })];
    const price = service.computePriceFromRules(rules, 'g1', undefined, undefined, undefined, 100);
    expect(price).toBeCloseTo(140);
  });

  it('COMPETITOR_PLUS працює як PERCENT', () => {
    const rules = [makeRule({ type: 'COMPETITOR_PLUS', percentValue: 15 })];
    const price = service.computePriceFromRules(rules, 'g1', undefined, undefined, undefined, 200);
    expect(price).toBeCloseTo(230);
  });

  it('FIXED_AMOUNT правило: cost + delta', () => {
    const rules = [makeRule({ type: 'FIXED_AMOUNT', fixedAmount: 75 })];
    const price = service.computePriceFromRules(rules, 'g1', undefined, undefined, undefined, 100);
    expect(price).toBe(175);
  });

  it('FIXED_PRICE правило: ігнорує cost, повертає fixedPrice', () => {
    const rules = [makeRule({ type: 'FIXED_PRICE', fixedPrice: 999 })];
    const price = service.computePriceFromRules(rules, 'g1', undefined, undefined, undefined, 100);
    expect(price).toBe(999);
  });

  it('COST_TIER: cost у тірі [0, 100) → застосовує markup', () => {
    const tiers = [
      { costMin: 0, costMax: 100, percentValue: 30, sortOrder: 0 },
      { costMin: 100, costMax: null, percentValue: 20, sortOrder: 1 },
    ];
    const rules = [makeRule({ type: 'COST_TIER', tiers })];
    const price = service.computePriceFromRules(rules, 'g1', undefined, undefined, undefined, 50);
    expect(price).toBeCloseTo(65); // 50 * 1.30
  });

  it('COST_TIER: cost не покритий жодним тіром → повертає costPrice', () => {
    const tiers = [{ costMin: 500, costMax: 1000, percentValue: 20, sortOrder: 0 }];
    const rules = [makeRule({ type: 'COST_TIER', tiers })];
    const price = service.computePriceFromRules(rules, 'g1', undefined, undefined, undefined, 50);
    expect(price).toBe(50);
  });

  it('roundTo: округлення до найближчого кратного', () => {
    const rules = [makeRule({ type: 'PERCENT', percentValue: 33, roundTo: 10 })];
    const price = service.computePriceFromRules(rules, 'g1', undefined, undefined, undefined, 100);
    // 100 * 1.33 = 133 → round(133/10)*10 = 130
    expect(price).toBe(130);
  });

  it('захист від від\'ємної ціни — Math.max(0, result)', () => {
    const rules = [makeRule({ type: 'FIXED_AMOUNT', fixedAmount: 0 })];
    const price = service.computePriceFromRules(rules, 'g1', undefined, undefined, undefined, -50);
    expect(price).toBe(0);
  });

  it('priority hierarchy: goodId > brandId > category > goodType > default', () => {
    const rules = [
      makeRule({ id: 'r-default', goodId: null, brandId: null, goodCategory: null, goodType: null, percentValue: 10 }),
      makeRule({ id: 'r-type', goodId: null, brandId: null, goodCategory: null, goodType: 'SPARE_PART', percentValue: 20 }),
      makeRule({ id: 'r-cat', goodId: null, brandId: null, goodCategory: 'BRAKES', percentValue: 30 }),
      makeRule({ id: 'r-brand', goodId: null, brandId: 'b1', percentValue: 40 }),
      makeRule({ id: 'r-good', goodId: 'g1', percentValue: 50 }),
    ];
    // goodId rule wins
    expect(service.computePriceFromRules(rules, 'g1', 'BRAKES', 'SPARE_PART', 'b1', 100)).toBeCloseTo(150);
  });

  it('brandId правило перекриває goodType (без goodId rule)', () => {
    const rules = [
      makeRule({ id: 'r-type', goodId: null, brandId: null, goodCategory: null, goodType: 'SPARE_PART', percentValue: 10 }),
      makeRule({ id: 'r-brand', goodId: null, brandId: 'b1', percentValue: 25 }),
    ];
    const price = service.computePriceFromRules(rules, 'g1', null as unknown as undefined, 'SPARE_PART', 'b1', 100);
    expect(price).toBeCloseTo(125); // brand rule wins
  });
});

describe('PricingService.getActiveRulesForOrg', () => {
  let service: PricingService;
  let prisma: { pricingRule: { findMany: ReturnType<typeof vi.fn> } };

  beforeEach(async () => {
    prisma = { pricingRule: { findMany: vi.fn().mockResolvedValue([]) } };
    const module = await Test.createTestingModule({
      providers: [
        PricingService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(PricingService);
  });

  it('викликає findMany з orgId, isActive: true, deletedAt: null', async () => {
    await service.getActiveRulesForOrg('org-X');
    expect(prisma.pricingRule.findMany).toHaveBeenCalledWith({
      where: { orgId: 'org-X', isActive: true, deletedAt: null },
      include: { tiers: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { priority: 'asc' },
      take: 200,
    });
  });

  it('повертає результат findMany напряму', async () => {
    const fixture = [{ id: 'r1', type: 'PERCENT' }];
    prisma.pricingRule.findMany.mockResolvedValueOnce(fixture);
    const result = await service.getActiveRulesForOrg('org-X');
    expect(result).toBe(fixture);
  });
});
