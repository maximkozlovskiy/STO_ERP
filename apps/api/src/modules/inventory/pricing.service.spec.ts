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
