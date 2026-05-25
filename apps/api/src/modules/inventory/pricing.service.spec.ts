import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { PricingService } from './pricing.service';
import { PrismaService } from '../../prisma/prisma.service';

type Rule = {
  id: string;
  goodId: string | null;
  goodCategory: string | null;
  goodType: string | null;
  type: string;
  percentValue: number | null;
  fixedAmount: number | null;
  fixedPrice: number | null;
  roundTo: number | null;
  priority: number;
  isActive: boolean;
  name: string;
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
    id: 'r1', goodId: null, goodCategory: null, goodType: null,
    type: 'PERCENT', percentValue: 30, fixedAmount: null, fixedPrice: null,
    roundTo: null, priority: 10, isActive: true, name: 'r',
    ...overrides,
  });

  it('повертає costPrice якщо правил немає', async () => {
    prisma.pricingRule.findMany.mockResolvedValue([]);
    const price = await service.calculateSalePrice('org', 'g', undefined, undefined, 100);
    expect(price).toBe(100);
  });

  it('PERCENT правило: cost * (1 + p/100)', async () => {
    prisma.pricingRule.findMany.mockResolvedValue([rule({ type: 'PERCENT', percentValue: 35 })]);
    const price = await service.calculateSalePrice('org', 'g', undefined, undefined, 200);
    expect(price).toBeCloseTo(270);
  });

  it('FIXED_AMOUNT правило: cost + amount', async () => {
    prisma.pricingRule.findMany.mockResolvedValue([rule({ type: 'FIXED_AMOUNT', fixedAmount: 50 })]);
    const price = await service.calculateSalePrice('org', 'g', undefined, undefined, 200);
    expect(price).toBe(250);
  });

  it('FIXED_PRICE правило: ігнорує cost', async () => {
    prisma.pricingRule.findMany.mockResolvedValue([rule({ type: 'FIXED_PRICE', fixedPrice: 999 })]);
    const price = await service.calculateSalePrice('org', 'g', undefined, undefined, 100);
    expect(price).toBe(999);
  });

  it('округлення roundTo', async () => {
    prisma.pricingRule.findMany.mockResolvedValue([rule({ type: 'PERCENT', percentValue: 33, roundTo: 1 })]);
    const price = await service.calculateSalePrice('org', 'g', undefined, undefined, 100); // 133 → 133
    expect(price).toBe(133);
  });

  it('правило по goodId перекриває загальні', async () => {
    prisma.pricingRule.findMany.mockResolvedValue([
      rule({ id: 'r-specific', goodId: 'g-x', percentValue: 50, priority: 100 }),
      rule({ id: 'r-default', goodId: null, percentValue: 20, priority: 1 }),
    ]);
    const price = await service.calculateSalePrice('org', 'g-x', undefined, undefined, 100);
    expect(price).toBe(150);
  });

  it('result не може бути від\'ємним', async () => {
    prisma.pricingRule.findMany.mockResolvedValue([rule({ type: 'FIXED_AMOUNT', fixedAmount: 0 })]);
    const price = await service.calculateSalePrice('org', 'g', undefined, undefined, -50);
    expect(price).toBe(0);
  });

  it('COMPETITOR_PLUS працює як PERCENT', async () => {
    prisma.pricingRule.findMany.mockResolvedValue([rule({ type: 'COMPETITOR_PLUS', percentValue: 10 })]);
    const price = await service.calculateSalePrice('org', 'g', undefined, undefined, 100);
    expect(price).toBeCloseTo(110);
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
      goodId: null, goodCategory: null, goodType: null,
      type: 'PERCENT', percentValue: 35, fixedAmount: null, fixedPrice: null, roundTo: null,
    }]);
    prisma.good.findMany.mockResolvedValue([
      { id: 'g1', purchasePrice: 100, salePrice: 135, category: null, goodType: null }, // no change → 135
      { id: 'g2', purchasePrice: 100, salePrice: 100, category: null, goodType: null }, // change → 135
    ]);
    const result = await service.applyRuleToGoods('org', 'r1');
    expect(result).toBe(1); // only g2 changed
  });
});
