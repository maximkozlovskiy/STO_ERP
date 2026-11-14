import { BadRequestException, Injectable } from '@nestjs/common';
import { GoodType, Prisma } from '@prisma/client';
import { translateError } from '@sto/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { findAllInPages } from '../../common/utils/pagination';
import { getLocale } from '../../common/tenant/tenant-context';

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
/** Сторінка товарів «Застосувати до всіх» (BR-GOOD-011): усі товари області, без стелі. */
export const APPLY_PAGE = 1000;

/**
 * Порядок правил — ОДИН для списку на сторінці правил і для вибору переможця розцінки
 * (BR-GOOD-012, №15): менше `priority` — першим; рівний `priority` — новіше правило вище в списку
 * й перемагає; `id` — останній ключ, щоб порядок рівних не залежав від плану запиту (інакше та
 * сама розцінка давала б різні ціни, а курсор сторінок — пропуски).
 */
export const PRICING_RULE_ORDER = [
  { priority: 'asc' },
  { createdAt: 'desc' },
  { id: 'asc' },
] satisfies Prisma.PricingRuleOrderByWithRelationInput[];

/** Нова ціна товару і правило, що її дало. Товар без жодного правила сюди не потрапляє (№17). */
type PriceUpdate = {
  goodId: string;
  oldPrice: number;
  newPrice: number;
  costPrice: number;
  rule: RuleEntry;
};

/** Підсумок «Застосувати до всіх»: перераховані товари й ті, яким не підійшло жодне правило. */
export interface ApplyRuleResult {
  updated: number;
  /** Товари області без жодного правила — ціну не змінено, історії немає (BR-GOOD-011, №17). */
  noRule: number;
}

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
    // Усі активні правила, без `take: 200`: правило за межею вибірки мовчки не діяло б — товари,
    // яких не накрили перші 200 правил, розцінювались би без націнки (і одне правило за id теж).
    const rules = await findAllInPages(page =>
      this.prisma.pricingRule.findMany({
        ...page,
        where: {
          orgId,
          isActive: true,
          deletedAt: null,
          ...(opts.onlyRuleId ? { id: opts.onlyRuleId } : {}),
        },
        include: RULE_INCLUDE,
        orderBy: PRICING_RULE_ORDER,
      }),
    );
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

  /** Категорія та всі її підкатегорії будь-якої глибини (BR-GOOD-010) — живі категорії org. */
  async categoryWithDescendants(orgId: string, rootId: string): Promise<string[]> {
    return this.withDescendants(await this.loadCategoryParents(orgId, true), rootId);
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

  /**
   * «Застосувати до всіх» (BR-GOOD-011): перераховує ціни ВСІХ товарів області правила —
   * сторінками, без стелі. Кожен товар розцінюється правилом-переможцем (`pickRule`), тож у
   * історію цін іде те правило, яке дало ціну, а не обов'язково застосоване. Вимкнене правило → 400.
   * Товар, якому не підійшло жодне правило (застосовано правило постачальника, а без постачальника
   * воно не діє), ціну НЕ змінює — він лише рахується в `noRule` (BR-GOOD-011, №17).
   */
  async applyRuleToGoods(orgId: string, ruleId: string): Promise<ApplyRuleResult> {
    const rule = await this.prisma.pricingRule.findFirst({
      where: { id: ruleId, orgId, deletedAt: null },
      include: { _count: { select: { goods: true } } },
    });
    if (!rule) return { updated: 0, noRule: 0 };
    // Вимкнене правило в розцінці не бере участі (контекст — лише активні): «застосувати» його
    // означало б розцінити товари області ІНШИМИ правилами під його назвою.
    if (!rule.isActive)
      throw new BadRequestException(translateError('err.pricingRule.inactive', getLocale()));

    // Область правила — ОДИН, найточніший вимір (як у resolveRule): список товарів > бренд >
    // категорія > тип > усе. Bug #178: раніше AND-ились категорія й тип, і комбіноване правило
    // «бренд + категорія» не перераховувало товари бренду поза категорією.
    let scope: Prisma.GoodWhereInput;
    if (rule._count.goods > 0) {
      scope = { pricingRuleLinks: { some: { pricingRuleId: rule.id } } };
    } else if (rule.brandId) {
      scope = { brandId: rule.brandId };
    } else if (rule.goodCategoryId) {
      scope = {
        goodCategoryId: { in: await this.categoryWithDescendants(orgId, rule.goodCategoryId) },
      };
    } else if (rule.goodCategory) {
      scope = { category: rule.goodCategory };
    } else if (rule.goodType) {
      scope = { goodType: rule.goodType as GoodType };
    } else {
      scope = {};
    }

    // Правила й дерево категорій — один раз; зв'язки списків — для кожної сторінки товарів.
    const base = await this.getPricingContext(orgId, []);

    // Товари області — сторінками за курсором `id`: колишня стеля `take: 5000` мовчки лишала
    // решту товарів зі старою ціною, а відповідь звітувала «перераховано» без попередження.
    let updated = 0;
    let noRule = 0;
    let cursor: string | undefined;
    for (;;) {
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
        orderBy: { id: 'asc' },
        take: APPLY_PAGE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (goods.length === 0) break;
      const ctx: PricingContext = {
        ...base,
        ruleIdsByGood: await this.loadGoodLinks(
          orgId,
          base.rules,
          goods.map(g => g.id),
        ),
      };
      const plan = this.planPrices(ctx, goods);
      noRule += plan.noRule;
      updated += await this.writePrices(orgId, plan.updates);
      if (goods.length < APPLY_PAGE) break;
      cursor = goods[goods.length - 1].id;
    }
    return { updated, noRule };
  }

  /**
   * Нові ціни сторінки товарів: лише ті, що змінились, з правилом-переможцем для історії.
   * Товар без жодного правила лишається з тією ціною, що була (`noRule`), — №17.
   */
  private planPrices(
    ctx: PricingContext,
    goods: Array<PricingGood & { purchasePrice: unknown; salePrice: unknown }>,
  ): { updates: PriceUpdate[]; noRule: number } {
    const updates: PriceUpdate[] = [];
    let noRule = 0;
    for (const good of goods) {
      const costPrice = Number(good.purchasePrice ?? good.salePrice);
      // Те саме, що computePriceFromRules, але з правилом-переможцем: ціну товару могло дати
      // точніше правило (список, бренд, ближча категорія), і в історії має стояти саме воно.
      const winner = this.pickRule(ctx, good);
      if (!winner) {
        noRule++;
        continue;
      }
      const newPrice = this._applyRule(winner, costPrice);
      const oldPrice = Number(good.salePrice);
      if (Math.abs(newPrice - oldPrice) > 0.001) {
        updates.push({ goodId: good.id, oldPrice, newPrice, costPrice, rule: winner });
      }
    }
    return { updates, noRule };
  }

  private async writePrices(orgId: string, updates: PriceUpdate[]): Promise<number> {
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
              reason: `PricingRule: ${u.rule.name}`,
              pricingRuleId: u.rule.id,
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
   * Рівні від точнішого до загальнішого; у межах рівня перемагає менше число `priority`, при
   * рівному — новіше правило (правила в контексті вже впорядковані `PRICING_RULE_ORDER`):
   *  0. правило постачальника — якщо постачальника передано; серед правил постачальника — ті самі
   *     рівні 1–5, і правило з областю поза нею не діє (BR-GOOD-012);
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
    // `ruleName: null` — правила немає; ціна тут лише заглушка, писати її не можна (№17).
    if (!rule) return { price: costPrice, ruleName: null };
    return { price: this._applyRule(rule, costPrice), ruleName: rule.name };
  }

  private pickRule(ctx: PricingContext, good: PricingGood, supplierId?: string): RuleEntry | null {
    // BR-GOOD-012: правила постачальника обираються тим самим каскадом області, що й загальні,
    // лише серед своїх. Правило постачальника зі списком / брендом / категорією / типом поза своєю
    // областю не діє — товар іде далі, до загальних правил.
    if (supplierId) {
      const bySupplier = this.pickInScope(
        ctx,
        good,
        ctx.rules.filter(r => r.supplierId === supplierId),
      );
      if (bySupplier) return bySupplier;
    }
    return this.pickInScope(
      ctx,
      good,
      ctx.rules.filter(r => !r.supplierId),
    );
  }

  /** Найточніше правило з `rules`, чия область накриває товар (рівні 1–5 з `resolveRule`). */
  private pickInScope(
    ctx: PricingContext,
    good: PricingGood,
    rules: RuleEntry[],
  ): RuleEntry | null {
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

  /**
   * Ціна за правилами; `null` — жодне правило товару не підійшло. Тоді ціну продажу НЕ чіпають і
   * історію не пишуть («Розцінити список», прийом партії — BR-GOOD-011, №17): колишнє «ціна =
   * собівартість» мовчки знімало націнку з товару, на який просто немає правила.
   */
  computePriceFromRules(
    ctx: PricingContext,
    good: PricingGood,
    costPrice: number,
    supplierId?: string,
  ): number | null {
    const rule = this.pickRule(ctx, good, supplierId);
    return rule ? this._applyRule(rule, costPrice) : null;
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
