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

    let updated = 0;
    for (const good of goods) {
      const costPrice = Number(good.purchasePrice ?? good.salePrice);
      const newPrice = await this.calculateSalePrice(
        orgId, good.id, good.category ?? undefined, good.goodType ?? undefined, costPrice,
      );
      if (Math.abs(newPrice - Number(good.salePrice)) > 0.001) {
        await this.prisma.good.update({ where: { id: good.id }, data: { salePrice: newPrice } });
        await this.prisma.priceHistory.create({
          data: {
            orgId,
            goodId: good.id,
            oldPrice: good.salePrice,
            newPrice,
            costPrice,
            reason: `PricingRule: ${rule.name}`,
            pricingRuleId: rule.id,
          },
        });
        updated++;
      }
    }
    return updated;
  }
}
