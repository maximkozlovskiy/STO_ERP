import { Injectable } from '@nestjs/common';
import { GoodType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export type RuleEntry = {
  id: string;
  name: string;
  /** Застаріла текстова категорія: лише правила, яким міграція не знайшла категорію в довіднику. */
  goodCategory: string | null;
  goodCategoryId: string | null;
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
  /** Скільки товарів у списку правила (BR-GOOD-009). >0 → правило діє ЛИШЕ на товари списку. */
  _count: { goods: number };
};

/** Що резолверу треба знати про товар. */
export interface PricingGood {
  id: string;
  goodCategoryId: string | null;
  /** Текстова категорія з картки — лише для застарілих текстових правил. */
  category: string | null;
  goodType: string | null;
  brandId: string | null;
}

/**
 * Усе, що потрібно, аби розцінити набір товарів без запитів у циклі: активні правила за
 * пріоритетом, списки товарів правил (лише для запитаних товарів) і батьки категорій.
 */
export interface PricingContext {
  rules: RuleEntry[];
  /** goodId → id правил, у списку яких цей товар є. */
  ruleIdsByGood: Map<string, Set<string>>;
  /** categoryId → parentId (null у кореня). Порожня, якщо жодне правило не має категорії. */
  categoryParent: Map<string, string | null>;
}

const RULE_INCLUDE = {
  tiers: { orderBy: { sortOrder: 'asc' } },
  _count: { select: { goods: true } },
} satisfies Prisma.PricingRuleInclude;

/** Postgres приймає до 32767 параметрів на запит. */
const IN_CHUNK = 5000;
/** Стеля на розмір довідника категорій однієї організації. */
const MAX_CATEGORIES = 5000;

@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Контекст розцінки для набору товарів.
   * `onlyRuleId` — розцінити одним конкретним правилом (закупівля → «розцінити правилом»).
   */
  async getPricingContext(
    orgId: string,
    goodIds: string[],
    opts: { onlyRuleId?: string } = {},
  ): Promise<PricingContext> {
    const all = await this.prisma.pricingRule.findMany({
      where: { orgId, isActive: true, deletedAt: null },
      include: RULE_INCLUDE,
      orderBy: { priority: 'asc' },
      take: 200,
    });
    const rules = opts.onlyRuleId ? all.filter(r => r.id === opts.onlyRuleId) : all;
    const [ruleIdsByGood, categoryParent] = await Promise.all([
      this.loadGoodLinks(orgId, rules, goodIds),
      this.loadCategoryParents(
        orgId,
        rules.some(r => r.goodCategoryId),
      ),
    ]);
    return { rules, ruleIdsByGood, categoryParent };
  }

  /** Зв'язки «товар → правило» лише для запитаних товарів: список правила може мати тисячі рядків. */
  private async loadGoodLinks(
    orgId: string,
    rules: RuleEntry[],
    goodIds: string[],
  ): Promise<Map<string, Set<string>>> {
    const map = new Map<string, Set<string>>();
    const ruleIds = rules.filter(r => r._count.goods > 0).map(r => r.id);
    const ids = Array.from(new Set(goodIds));
    if (ruleIds.length === 0 || ids.length === 0) return map;
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK);
      const links = await this.prisma.pricingRuleGood.findMany({
        where: { orgId, pricingRuleId: { in: ruleIds }, goodId: { in: chunk } },
        select: { pricingRuleId: true, goodId: true },
        take: IN_CHUNK * ruleIds.length,
      });
      for (const l of links) {
        const set = map.get(l.goodId);
        if (set) set.add(l.pricingRuleId);
        else map.set(l.goodId, new Set([l.pricingRuleId]));
      }
    }
    return map;
  }

  private async loadCategoryParents(
    orgId: string,
    needed: boolean,
  ): Promise<Map<string, string | null>> {
    if (!needed) return new Map();
    const categories = await this.prisma.goodCategory.findMany({
      where: { orgId, deletedAt: null },
      select: { id: true, parentId: true },
      take: MAX_CATEGORIES,
    });
    return new Map(categories.map(c => [c.id, c.parentId]));
  }

  /** Категорія та всі її підкатегорії (BR-GOOD-010). */
  private withDescendants(categoryParent: Map<string, string | null>, rootId: string): string[] {
    const children = new Map<string, string[]>();
    for (const [id, parentId] of categoryParent) {
      if (!parentId) continue;
      const list = children.get(parentId);
      if (list) list.push(id);
      else children.set(parentId, [id]);
    }
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [rootId];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      stack.push(...(children.get(id) ?? []));
    }
    return out;
  }

  async applyRuleToGoods(orgId: string, ruleId: string): Promise<number> {
    const rule = await this.prisma.pricingRule.findFirst({
      where: { id: ruleId, orgId, deletedAt: null },
      include: { _count: { select: { goods: true } } },
    });
    if (!rule) return 0;

    // Область правила — ОДИН, найточніший вимір (як у resolveRule): список товарів > бренд >
    // категорія > тип > усе. Bug #178: раніше AND-ились категорія й тип, і комбіноване правило
    // «бренд + категорія» не перераховувало товари бренду поза категорією.
    let scope: Prisma.GoodWhereInput;
    if (rule._count.goods > 0) {
      scope = { pricingRuleLinks: { some: { pricingRuleId: rule.id } } };
    } else if (rule.brandId) {
      scope = { brandId: rule.brandId };
    } else if (rule.goodCategoryId) {
      const parents = await this.loadCategoryParents(orgId, true);
      scope = { goodCategoryId: { in: this.withDescendants(parents, rule.goodCategoryId) } };
    } else if (rule.goodCategory) {
      scope = { category: rule.goodCategory };
    } else if (rule.goodType) {
      scope = { goodType: rule.goodType as GoodType };
    } else {
      scope = {};
    }

    const goods = await this.prisma.good.findMany({
      where: { orgId, deletedAt: null, ...scope },
      select: {
        id: true,
        purchasePrice: true,
        salePrice: true,
        category: true,
        goodCategoryId: true,
        goodType: true,
        brandId: true,
      },
      take: 5000,
    });
    const ctx = await this.getPricingContext(
      orgId,
      goods.map(g => g.id),
    );

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
      const newPrice = this.computePriceFromRules(ctx, good, costPrice);
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

  /**
   * Вибирає правило для товару й рахує ціну. Без запитів — для циклів по рядках документа.
   *
   * Рівні від точнішого до загальнішого; у межах рівня перемагає менше число `priority`
   * (правила в контексті вже впорядковані):
   *  0. правило постачальника — якщо постачальника передано;
   *  1. товар є у списку правила (BR-GOOD-009);
   *  2. бренд;
   *  3. категорія з довідника — категорія товару або її предок, БЛИЖЧИЙ предок перемагає
   *     (BR-GOOD-010); після них — застарілі правила з текстовою категорією;
   *  4. тип товару;
   *  5. весь асортимент.
   * Правило зі списком товарів на товари поза списком не діє — воно не «весь асортимент».
   */
  resolveRule(
    ctx: PricingContext,
    good: PricingGood,
    costPrice: number,
    supplierId?: string,
  ): { price: number; ruleName: string | null } {
    const rule = this.pickRule(ctx, good, supplierId);
    if (!rule) return { price: costPrice, ruleName: null };
    return { price: this._applyRule(rule, costPrice), ruleName: rule.name };
  }

  private pickRule(ctx: PricingContext, good: PricingGood, supplierId?: string): RuleEntry | null {
    if (supplierId) {
      const supplierRule = ctx.rules.find(r => r.supplierId === supplierId);
      if (supplierRule) return supplierRule;
    }
    const rules = ctx.rules.filter(r => !r.supplierId);

    const listed = ctx.ruleIdsByGood.get(good.id);
    const hasGoods = (r: RuleEntry) => r._count.goods > 0;
    const hasCategory = (r: RuleEntry) => !!r.goodCategoryId || !!r.goodCategory;

    const byGood = listed ? rules.find(r => hasGoods(r) && listed.has(r.id)) : undefined;
    if (byGood) return byGood;

    // Нижче — лише правила без списку товарів.
    const open = rules.filter(r => !hasGoods(r));

    if (good.brandId) {
      const byBrand = open.find(r => r.brandId === good.brandId);
      if (byBrand) return byBrand;
    }

    const noBrand = open.filter(r => !r.brandId);
    for (const categoryId of this.categoryChain(ctx.categoryParent, good.goodCategoryId)) {
      const byCategory = noBrand.find(r => r.goodCategoryId === categoryId);
      if (byCategory) return byCategory;
    }
    if (good.category) {
      const byText = noBrand.find(r => !r.goodCategoryId && r.goodCategory === good.category);
      if (byText) return byText;
    }

    const noCategory = noBrand.filter(r => !hasCategory(r));
    if (good.goodType) {
      const byType = noCategory.find(r => r.goodType === good.goodType);
      if (byType) return byType;
    }
    return noCategory.find(r => !r.goodType) ?? null;
  }

  /** Категорія товару і її предки, від найближчого. Цикл у даних не зациклює обхід. */
  private categoryChain(
    categoryParent: Map<string, string | null>,
    categoryId: string | null,
  ): string[] {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current = categoryId;
    while (current && !seen.has(current)) {
      seen.add(current);
      chain.push(current);
      current = categoryParent.get(current) ?? null;
    }
    return chain;
  }

  computePriceFromRules(
    ctx: PricingContext,
    good: PricingGood,
    costPrice: number,
    supplierId?: string,
  ): number {
    return this.resolveRule(ctx, good, costPrice, supplierId).price;
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
