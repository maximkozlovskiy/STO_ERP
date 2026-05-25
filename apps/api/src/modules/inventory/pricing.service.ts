import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}

  async calculateSalePrice(
    orgId: string,
    goodId: string,
    goodCategory: string | undefined,
    goodType: string | undefined,
    costPrice: number,
  ): Promise<number> {
    // Find the most specific active rule (lowest priority number wins)
    const rules = await this.prisma.pricingRule.findMany({
      where: {
        orgId,
        isActive: true,
        deletedAt: null,
        OR: [
          { goodId },
          { goodId: null, goodCategory: goodCategory ?? null },
          { goodId: null, goodCategory: null, goodType: goodType ?? null },
          { goodId: null, goodCategory: null, goodType: null },
        ],
      },
      orderBy: { priority: 'asc' },
      take: 10,
    });

    if (!rules.length) return costPrice;

    // Pick the most specific matching rule
    const rule =
      rules.find(r => r.goodId === goodId) ??
      rules.find(r => !r.goodId && r.goodCategory === goodCategory) ??
      rules.find(r => !r.goodId && !r.goodCategory && r.goodType === goodType) ??
      rules.find(r => !r.goodId && !r.goodCategory && !r.goodType) ??
      rules[0];

    let result: number;

    switch (rule.type) {
      case 'PERCENT':
        result = costPrice * (1 + Number(rule.percentValue ?? 0) / 100);
        break;
      case 'FIXED_AMOUNT':
        result = costPrice + Number(rule.fixedAmount ?? 0);
        break;
      case 'FIXED_PRICE':
        result = Number(rule.fixedPrice ?? costPrice);
        break;
      case 'COMPETITOR_PLUS':
        result = costPrice * (1 + Number(rule.percentValue ?? 0) / 100);
        break;
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

    const where = {
      orgId,
      deletedAt: null as null,
      ...(rule.goodId ? { id: rule.goodId } : {}),
      ...(rule.goodCategory ? { category: rule.goodCategory } : {}),
      ...(rule.goodType ? { goodType: rule.goodType as never } : {}),
    };

    const goods = await this.prisma.good.findMany({
      where,
      select: { id: true, purchasePrice: true, salePrice: true, category: true, goodType: true },
      take: 5000,
    });

    // Prefetch all active rules once — avoid N+1 in calculateSalePrice loop
    const allRules = await this.prisma.pricingRule.findMany({
      where: { orgId, isActive: true, deletedAt: null },
      orderBy: { priority: 'asc' },
      take: 200,
    });

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
        allRules, good.id, good.category ?? undefined, good.goodType ?? undefined, costPrice,
      );
      const oldPrice = Number(good.salePrice);
      if (Math.abs(newPrice - oldPrice) > 0.001) {
        updates.push({ goodId: good.id, oldPrice, newPrice, costPrice });
      }
    }

    // Batch in chunks of 100 to keep transactions short (< 5s)
    const CHUNK = 100;
    for (let i = 0; i < updates.length; i += CHUNK) {
      const chunk = updates.slice(i, i + CHUNK);
      await this.prisma.$transaction([
        ...chunk.map(u =>
          this.prisma.good.update({ where: { id: u.goodId }, data: { salePrice: u.newPrice } }),
        ),
        this.prisma.priceHistory.createMany({
          data: chunk.map(u => ({
            orgId,
            goodId: u.goodId,
            oldPrice: u.oldPrice,
            newPrice: u.newPrice,
            costPrice: u.costPrice,
            reason: `PricingRule: ${rule.name}`,
            pricingRuleId: rule.id,
          })),
        }),
      ]);
    }
    return updates.length;
  }

  // Pure in-memory rule resolution (no DB calls) — used in tight loops like applyRuleToGoods
  private computePriceFromRules(
    rules: Array<{
      goodId: string | null;
      goodCategory: string | null;
      goodType: string | null;
      type: string;
      percentValue: unknown;
      fixedAmount: unknown;
      fixedPrice: unknown;
      roundTo: unknown;
    }>,
    goodId: string,
    goodCategory: string | undefined,
    goodType: string | undefined,
    costPrice: number,
  ): number {
    const candidates = rules.filter(r =>
      r.goodId === goodId ||
      (!r.goodId && r.goodCategory === (goodCategory ?? null)) ||
      (!r.goodId && !r.goodCategory && r.goodType === (goodType ?? null)) ||
      (!r.goodId && !r.goodCategory && !r.goodType),
    );
    if (!candidates.length) return costPrice;

    const rule =
      candidates.find(r => r.goodId === goodId) ??
      candidates.find(r => !r.goodId && r.goodCategory === goodCategory) ??
      candidates.find(r => !r.goodId && !r.goodCategory && r.goodType === goodType) ??
      candidates.find(r => !r.goodId && !r.goodCategory && !r.goodType) ??
      candidates[0];

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
