import { Injectable } from '@nestjs/common';
import { GoodType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type RuleEntry = {
  name: string;
  goodId: string | null;
  goodCategory: string | null;
  goodType: string | null;
  brandId: string | null;
  supplierId: string | null;
  type: string;
  percentValue: unknown;
  fixedAmount: unknown;
  fixedPrice: unknown;
  roundTo: unknown;
  tiers: Array<{
    costMin: unknown;
    costMax: unknown | null;
    percentValue: unknown;
    sortOrder: number;
  }>;
};

@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}

  async calculateSalePrice(
    orgId: string,
    goodId: string | null,
    goodCategory: string | null,
    goodType: string | null,
    brandId: string | null,
    costPrice: number,
  ): Promise<number> {
    // Find the most specific active rule (lowest priority number wins).
    // Rule with goodId must point to a non-soft-deleted Good — filter the relation.
    // Priority hierarchy: goodId(1) > brandId(2) > goodCategory(3) > goodType(4) > all(10)
    const orConditions: Array<Record<string, unknown>> = [
      { goodId: null, goodCategory: null, goodType: null, brandId: null },
    ];
    if (goodType) orConditions.push({ goodId: null, goodCategory: null, goodType, brandId: null });
    if (goodCategory)
      orConditions.push({ goodId: null, goodCategory, goodType: null, brandId: null });
    if (brandId) orConditions.push({ goodId: null, brandId });
    if (goodId) orConditions.push({ goodId, good: { deletedAt: null } });

    const rules = await this.prisma.pricingRule.findMany({
      where: {
        orgId,
        isActive: true,
        deletedAt: null,
        OR: orConditions,
      },
      include: { tiers: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { priority: 'asc' },
      take: 20,
    });

    if (!rules.length) return costPrice;

    // Pick the most specific matching rule using priority hierarchy
    const rule =
      (goodId ? rules.find(r => r.goodId === goodId) : undefined) ??
      (brandId ? rules.find(r => !r.goodId && r.brandId === brandId) : undefined) ??
      (goodCategory
        ? rules.find(r => !r.goodId && !r.brandId && r.goodCategory === goodCategory)
        : undefined) ??
      (goodType
        ? rules.find(r => !r.goodId && !r.brandId && !r.goodCategory && r.goodType === goodType)
        : undefined) ??
      rules.find(r => !r.goodId && !r.brandId && !r.goodCategory && !r.goodType) ??
      rules[0];

    let result: number;

    switch (rule.type) {
      case 'PERCENT':
      case 'COMPETITOR_PLUS':
        result = costPrice * (1 + Number(rule.percentValue ?? 0) / 100);
        break;
      case 'FIXED_AMOUNT':
        result = costPrice + Number(rule.fixedAmount ?? 0);
        break;
      case 'FIXED_PRICE':
        result = Number(rule.fixedPrice ?? costPrice);
        break;
      case 'COST_TIER': {
        // Find the matching tier: costMin <= costPrice < costMax (or costMax IS NULL = last tier)
        const tier = rule.tiers.find(t => {
          const min = Number(t.costMin);
          const max = t.costMax != null ? Number(t.costMax) : null;
          return costPrice >= min && (max === null || costPrice < max);
        });
        result = tier ? costPrice * (1 + Number(tier.percentValue) / 100) : costPrice; // no matching tier → no markup
        break;
      }
      default:
        result = costPrice;
    }

    // Round if specified
    if (rule.roundTo && Number(rule.roundTo) > 0) {
      const r = Number(rule.roundTo);
      result = Math.round(result / r) * r;
    }

    return Math.max(0, result);
  }

  async applyRuleToGoods(orgId: string, ruleId: string): Promise<number> {
    const rule = await this.prisma.pricingRule.findFirst({
      where: { id: ruleId, orgId, deletedAt: null },
    });
    if (!rule) return 0;

    // brandId scope: if the rule is brand-scoped, recalculate ONLY goods of that brand.
    const where = {
      orgId,
      deletedAt: null as null,
      ...(rule.goodId ? { id: rule.goodId } : {}),
      ...(rule.brandId && !rule.goodId ? { brandId: rule.brandId } : {}),
      ...(rule.goodCategory ? { category: rule.goodCategory } : {}),
      ...(rule.goodType ? { goodType: rule.goodType as GoodType } : {}),
    };

    // Parallel: goods scope + active rules — обидва незалежні fetch'і, можуть виконуватись одночасно.
    // Раніше було послідовно (goods → allRules), хоча allRules не залежить від goods.
    const [goods, allRules] = await Promise.all([
      this.prisma.good.findMany({
        where,
        select: {
          id: true,
          purchasePrice: true,
          salePrice: true,
          category: true,
          goodType: true,
          brandId: true,
        },
        take: 5000,
      }),
      this.prisma.pricingRule.findMany({
        where: { orgId, isActive: true, deletedAt: null },
        include: { tiers: { orderBy: { sortOrder: 'asc' } } },
        orderBy: { priority: 'asc' },
        take: 200,
      }),
    ]);

    // Compute new prices in memory, then batch-update via $transaction chunks
    type PriceUpdate = {
      goodId: string;
      oldPrice: number;
      newPrice: number;
      costPrice: number;
    };
    const updates: PriceUpdate[] = [];
    for (const good of goods) {
      const costPrice = Number(good.purchasePrice ?? good.salePrice);
      const newPrice = this.computePriceFromRules(
        allRules,
        good.id,
        good.category ?? undefined,
        good.goodType ?? undefined,
        good.brandId ?? undefined,
        costPrice,
      );
      const oldPrice = Number(good.salePrice);
      if (Math.abs(newPrice - oldPrice) > 0.001) {
        updates.push({ goodId: good.id, oldPrice, newPrice, costPrice });
      }
    }

    // Batch in chunks of 100 to keep transactions short (< 5s)
    // Array-form $transaction doesn't accept a timeout; use callback form for explicit { timeout }.
    // Тому перетворюємо array на callback, щоб мати explicit { timeout } і не покладатись на default 5s.
    const CHUNK = 100;
    for (let i = 0; i < updates.length; i += CHUNK) {
      const chunk = updates.slice(i, i + CHUNK);
      await this.prisma.$transaction(
        async tx => {
          // sto-optimize: всі u.goodId всередині chunk унікальні (plan accumulator не дублює PK)
          // → disjoint PK writes, race-safe. Promise.all дає JS-overhead-economy у $transaction
          // (Prisma serializes на pinned connection — рядкові writes йдуть послідовно у SQL,
          // але без JS await між ними скорочується кількість мікрозадач event-loop).
          // sto-review §2.2: defense-in-depth tenant guard — updateMany з orgId/deletedAt:null
          // (узгоджено з purchase-orders.applyPricing і xlsx.applyPricingFromList).
          await Promise.all(
            chunk.map(u =>
              tx.good.updateMany({
                where: { id: u.goodId, orgId, deletedAt: null },
                data: { salePrice: u.newPrice },
              }),
            ),
          );
          await tx.priceHistory.createMany({
            data: chunk.map(u => ({
              orgId,
              goodId: u.goodId,
              oldPrice: u.oldPrice,
              newPrice: u.newPrice,
              costPrice: u.costPrice,
              reason: `PricingRule: ${rule.name}`,
              pricingRuleId: rule.id,
            })),
          });
        },
        { timeout: 10_000 },
      );
    }
    return updates.length;
  }

  async getActiveRulesForOrg(orgId: string) {
    return this.prisma.pricingRule.findMany({
      where: { orgId, isActive: true, deletedAt: null },
      include: { tiers: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { priority: 'asc' },
      take: 200,
    });
  }

  // resolveRule: повертає розраховану ціну + назву правила що її утворило.
  // Використовується в applyPricing щоб зберегти pricedSalePrice + pricingRuleName на лінії.
  resolveRule(
    rules: RuleEntry[],
    goodId: string,
    goodCategory: string | undefined,
    goodType: string | undefined,
    brandId: string | undefined,
    costPrice: number,
    supplierId?: string,
  ): { price: number; ruleName: string | null } {
    if (supplierId) {
      const supplierRules = rules.filter(r => r.supplierId === supplierId);
      if (supplierRules.length > 0) {
        const rule = supplierRules[0]!;
        return { price: this._applyRule(rule, costPrice), ruleName: rule.name };
      }
    }

    const candidates = rules.filter(
      r =>
        !r.supplierId &&
        (r.goodId === goodId ||
          (!r.goodId && r.brandId === (brandId ?? null)) ||
          (!r.goodId && !r.brandId && r.goodCategory === (goodCategory ?? null)) ||
          (!r.goodId && !r.brandId && !r.goodCategory && r.goodType === (goodType ?? null)) ||
          (!r.goodId && !r.brandId && !r.goodCategory && !r.goodType)),
    );
    if (!candidates.length) return { price: costPrice, ruleName: null };

    const rule =
      candidates.find(r => r.goodId === goodId) ??
      (brandId ? candidates.find(r => !r.goodId && r.brandId === brandId) : undefined) ??
      candidates.find(r => !r.goodId && !r.brandId && r.goodCategory === goodCategory) ??
      candidates.find(r => !r.goodId && !r.brandId && !r.goodCategory && r.goodType === goodType) ??
      candidates.find(r => !r.goodId && !r.brandId && !r.goodCategory && !r.goodType) ??
      candidates[0]!;

    return { price: this._applyRule(rule, costPrice), ruleName: rule.name };
  }

  // Pure in-memory rule resolution (no DB calls) — used in tight loops like applyRuleToGoods
  // supplierId: якщо вказано — спочатку шукаємо правило цього постачальника (найвищий пріоритет).
  computePriceFromRules(
    rules: RuleEntry[],
    goodId: string,
    goodCategory: string | undefined,
    goodType: string | undefined,
    brandId: string | undefined,
    costPrice: number,
    supplierId?: string,
  ): number {
    return this.resolveRule(rules, goodId, goodCategory, goodType, brandId, costPrice, supplierId)
      .price;
  }

  private _applyRule(
    rule: {
      type: string;
      percentValue: unknown;
      fixedAmount: unknown;
      fixedPrice: unknown;
      roundTo: unknown;
      tiers: Array<{
        costMin: unknown;
        costMax: unknown | null;
        percentValue: unknown;
        sortOrder: number;
      }>;
    },
    costPrice: number,
  ): number {
    let result: number;
    switch (rule.type) {
      case 'PERCENT':
      case 'COMPETITOR_PLUS':
        result = costPrice * (1 + Number(rule.percentValue ?? 0) / 100);
        break;
      case 'FIXED_AMOUNT':
        result = costPrice + Number(rule.fixedAmount ?? 0);
        break;
      case 'FIXED_PRICE':
        result = Number(rule.fixedPrice ?? costPrice);
        break;
      case 'COST_TIER': {
        const tier = rule.tiers.find(t => {
          const min = Number(t.costMin);
          const max = t.costMax != null ? Number(t.costMax) : null;
          return costPrice >= min && (max === null || costPrice < max);
        });
        result = tier ? costPrice * (1 + Number(tier.percentValue) / 100) : costPrice;
        break;
      }
      default:
        result = costPrice;
    }
    if (rule.roundTo && Number(rule.roundTo) > 0) {
      const r = Number(rule.roundTo);
      result = Math.round(result / r) * r;
    }
    return Math.max(0, result);
  }
}
