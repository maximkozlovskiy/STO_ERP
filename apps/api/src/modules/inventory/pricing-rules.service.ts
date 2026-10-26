import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PRICING_RULE_MAX_GOODS, translateError } from '@sto/shared';
import { Prisma } from '@prisma/client';
import { getLocale } from '../../common/tenant/tenant-context';
import { PricingService } from './pricing.service';
import { PrismaService } from '../../prisma/prisma.service';
import { findAllInPages } from '../../common/utils/pagination';
import { AuditService } from '../audit/audit.service';
import {
  ApplyPricingRuleResultDto,
  CreatePricingRuleDto,
  PaginatedPricingRulesDto,
  PricingRuleGoodRefDto,
  PricingRuleGoodsDto,
  PricingRuleResponseDto,
  UpdatePricingRuleDto,
} from './pricing-rules.dto';

/** Товар списку правила — рівно ті поля, які показує форма. */
const RULE_GOOD_SELECT = {
  id: true,
  internalCode: true,
  name: true,
  sku: true,
  brand: { select: { name: true } },
} satisfies Prisma.GoodSelect;

type RuleGood = Prisma.GoodGetPayload<{ select: typeof RULE_GOOD_SELECT }>;

/** Скільки товарів списку віддає список правил (решта — GET :id/goods). */
const GOODS_PREVIEW = 3;

// sto-review §13 + accumulated pattern (2026-06-19, relation-include drift):
// один shared include shape для findAll/create/update — гарантує, що додавання
// нового scalar (наприклад good.internalCode) не оминає жоден з 4 endpoints.
const PRICING_RULE_INCLUDE = {
  category: { select: { id: true, name: true } },
  brand: { select: { id: true, name: true } },
  supplier: { select: { id: true, firstName: true, lastName: true, companyName: true } },
  tiers: { orderBy: { sortOrder: 'asc' } },
  // Видалені товари у списку не показуємо й не рахуємо (самі рядки-зв'язки лишаються: товар
  // можуть відновити, і правило зі списком не має раптом стати правилом «на весь асортимент»).
  goods: {
    where: { good: { deletedAt: null } },
    orderBy: { good: { name: 'asc' } },
    take: GOODS_PREVIEW,
    select: { good: { select: RULE_GOOD_SELECT } },
  },
  _count: { select: { goods: { where: { good: { deletedAt: null } } } } },
} satisfies Prisma.PricingRuleInclude;

type PricingRuleWithRelations = Prisma.PricingRuleGetPayload<{
  include: typeof PRICING_RULE_INCLUDE;
}>;

/** Область правила після злиття з наявним станом і нормалізації: заповнено один вимір. */
interface RuleScope {
  goodIds: string[] | undefined;
  hasGoods: boolean;
  brandId: string | null;
  goodCategoryId: string | null;
  goodCategory: string | null;
  goodType: string | null;
}

const IN_CHUNK = 5000;

/** CRUD правил ціноутворення (BR-GOOD-009). Аудит — тут: правила націнки впливають на ціни. */
@Injectable()
export class PricingRulesService {
  private readonly logger = new Logger(PricingRulesService.name);

  constructor(
    private readonly pricingService: PricingService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** C1b: best-effort аудит правила ціноутворення. */
  private auditRule(
    orgId: string,
    id: string,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    userId: string | undefined,
    oldData?: Record<string, unknown>,
    newData?: Record<string, unknown>,
  ): void {
    if (!userId) return;
    this.audit
      .record(orgId, 'PricingRule', id, action, userId, oldData, newData)
      .catch((e: unknown) =>
        this.logger.warn(`Audit record failed: ${e instanceof Error ? e.message : e}`),
      );
  }

  async findAll(orgId: string, supplierId?: string): Promise<PaginatedPricingRulesDto> {
    // orgId filter ensures a malicious UUID from another org returns 0 rows even if the
    // supplierId exists there.
    const where: Prisma.PricingRuleWhereInput = {
      orgId,
      deletedAt: null,
      ...(supplierId ? { supplierId } : {}),
    };
    // Сторінка правил показує всі правила одним списком: `take: 200` мовчки ховав решту, хоча
    // вони діяли в розцінці. id — другий ключ, щоб курсор сторінок мав стабільний порядок.
    const rules = await findAllInPages(page =>
      this.prisma.pricingRule.findMany({
        ...page,
        where,
        include: PRICING_RULE_INCLUDE,
        orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
      }),
    );
    const deadLists = await this.listsOfDeletedGoods(this.prisma, orgId, rules);
    return {
      items: rules.map(r => this.toDto(r, deadLists.has(r.id))),
      total: rules.length,
      page: 1,
      limit: rules.length,
    };
  }

  async findGoods(orgId: string, id: string): Promise<PricingRuleGoodsDto> {
    const rule = await this.prisma.pricingRule.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!rule) throw new NotFoundException(translateError('err.pricingRule.notFound', getLocale()));
    const links = await this.prisma.pricingRuleGood.findMany({
      where: { orgId, pricingRuleId: id, good: { deletedAt: null } },
      orderBy: { good: { name: 'asc' } },
      take: PRICING_RULE_MAX_GOODS,
      select: { good: { select: RULE_GOOD_SELECT } },
    });
    const items = links.map(l => this.toGoodRef(l.good));
    return { items, total: items.length };
  }

  async create(
    orgId: string,
    userId: string | undefined,
    dto: CreatePricingRuleDto,
  ): Promise<PricingRuleResponseDto> {
    const goodIds = dto.goodIds ? Array.from(new Set(dto.goodIds)) : [];
    const scope = this.normalizeScope({
      goodIds,
      hasGoods: goodIds.length > 0,
      brandId: dto.brandId ?? null,
      goodCategoryId: dto.goodCategoryId ?? null,
      goodCategory: null,
      goodType: dto.goodType ?? null,
    });
    await this.assertRefs(this.prisma, orgId, scope, dto.supplierId ?? null);

    const { tiers, ...values } = this.cleanValuesForType(dto);
    const rule = await this.prisma.$transaction(
      async tx => {
        const created = await tx.pricingRule.create({
          data: {
            orgId,
            name: values.name,
            type: values.type,
            priority: values.priority ?? 10,
            percentValue: values.percentValue,
            fixedAmount: values.fixedAmount,
            fixedPrice: values.fixedPrice,
            roundTo: values.roundTo,
            brandId: scope.brandId,
            goodCategoryId: scope.goodCategoryId,
            goodType: scope.goodType,
            supplierId: dto.supplierId ?? null,
            ...(tiers && tiers.length > 0
              ? {
                  tiers: {
                    createMany: {
                      data: tiers.map((t, i) => ({
                        costMin: t.costMin,
                        costMax: t.costMax ?? null,
                        percentValue: t.percentValue,
                        sortOrder: t.sortOrder ?? i,
                      })),
                    },
                  },
                }
              : {}),
          },
          select: { id: true },
        });
        await this.writeGoods(tx, orgId, created.id, scope.goodIds ?? []);
        return tx.pricingRule.findFirstOrThrow({
          where: { id: created.id, orgId },
          include: PRICING_RULE_INCLUDE,
        });
      },
      { timeout: 20_000 },
    );
    this.auditRule(orgId, rule.id, 'CREATE', userId, undefined, {
      name: values.name,
      priority: values.priority ?? 10,
    });
    // Новий список складається лише з живих товарів (assertRefs) — «мертвим» він бути не може.
    return this.toDto(rule, false);
  }

  async update(
    orgId: string,
    userId: string | undefined,
    id: string,
    dto: UpdatePricingRuleDto,
  ): Promise<PricingRuleResponseDto> {
    const goodIds = dto.goodIds !== undefined ? Array.from(new Set(dto.goodIds)) : undefined;
    const categoryTouched = dto.goodCategoryId !== undefined;
    const { tiers, ...values } = this.cleanValuesForType(dto);

    const rule = await this.prisma.$transaction(
      async tx => {
        // Два одночасні PATCH одного правила читали той самий стан і писали кожен своє: списки
        // зливались у об'єднання, а правило лишалось і зі списком, і з брендом. Блокування на
        // правило робить «прочитав стан → злив → записав» послідовним; стан читаємо ВЖЕ під ним.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pricing-rule:${id}`}))`;
        const existing = await tx.pricingRule.findFirst({
          where: { id, orgId, deletedAt: null },
          include: { _count: { select: { goods: true } } },
        });
        if (!existing)
          throw new NotFoundException(translateError('err.pricingRule.notFound', getLocale()));

        // PATCH зливає надіслане з наявним станом ПЕРЕД нормалізацією: якщо клієнт шле лише
        // бренд, а правило мало список товарів, область має лишитись несуперечливою (один вимір).
        // undefined — поле не чіпали; null (для списку — []) — зняти значення.
        const supplierId = dto.supplierId !== undefined ? dto.supplierId : existing.supplierId;
        // Bug #834: у списку можуть лишитись самі видалені товари. Форма таких не показує —
        // список у ній порожній і його нічим очистити, а бренд, категорія й тип доступні. Якщо
        // запит явно обирає вимір і живих товарів у списку немає — це вже не правило зі списком:
        // інакше обране мовчки відкидалось би, і перетворити таке правило було б неможливо.
        let listStands = existing._count.goods > 0;
        if (
          listStands &&
          goodIds === undefined &&
          (dto.brandId || dto.goodCategoryId || dto.goodType)
        ) {
          const liveGoods = await tx.pricingRuleGood.count({
            where: { orgId, pricingRuleId: id, good: { deletedAt: null } },
          });
          listStands = liveGoods > 0;
        }
        const scope = this.normalizeScope({
          goodIds,
          hasGoods: goodIds !== undefined ? goodIds.length > 0 : listStands,
          brandId: dto.brandId !== undefined ? dto.brandId : existing.brandId,
          goodCategoryId: categoryTouched ? (dto.goodCategoryId ?? null) : existing.goodCategoryId,
          // Стара текстова категорія живе, доки категорію не чіпали; вибір (або зняття) прибирає.
          goodCategory: categoryTouched ? null : existing.goodCategory,
          goodType: dto.goodType !== undefined ? dto.goodType : existing.goodType,
        });
        // Перевіряємо лише посилання, які прийшли в ЦЬОМУ запиті. Категорію чи бренд, що вже
        // стояли на правилі, могли видалити пізніше — таке правило мусить лишатись редагованим
        // (вимкнути, перейменувати, обрати іншу категорію), а не віддавати 404 на будь-яку правку.
        await this.assertRefs(
          tx,
          orgId,
          {
            ...scope,
            goodCategoryId: categoryTouched ? scope.goodCategoryId : null,
            brandId: dto.brandId !== undefined ? scope.brandId : null,
          },
          dto.supplierId ?? null,
        );

        // Область пишемо ЯВНО цілком (зокрема null): інакше «понижене» нормалізацією поле
        // лишиться в базі зі старим значенням і правило матиме два виміри водночас.
        const updateData: Prisma.PricingRuleUncheckedUpdateInput = {
          name: values.name,
          type: values.type,
          priority: values.priority,
          percentValue: values.percentValue,
          fixedAmount: values.fixedAmount,
          fixedPrice: values.fixedPrice,
          roundTo: values.roundTo,
          isActive: values.isActive,
          goodId: null,
          brandId: scope.brandId,
          goodCategoryId: scope.goodCategoryId,
          goodCategory: scope.goodCategory,
          goodType: scope.goodType,
          supplierId: supplierId ?? null,
        };

        // Якщо тип змінено НЕ на COST_TIER — старі тіри стають мертвим вантажем (не
        // використовуються, але «відроджуються», якщо користувач перемкнеться назад).
        const switchedAwayFromCostTier =
          values.type !== undefined && values.type !== 'COST_TIER' && existing.type === 'COST_TIER';
        // Список чистимо і тоді, коли його не надсилали, але область перейшла на інший вимір.
        const dropGoods = !scope.hasGoods && existing._count.goods > 0;

        if (tiers !== undefined || switchedAwayFromCostTier) {
          // Тіри не мають власного orgId; правило перевірене вище, фільтр по pricingRuleId безпечний.
          await tx.pricingRuleTier.deleteMany({ where: { pricingRuleId: id } });
        }
        if (tiers !== undefined && tiers.length > 0) {
          await tx.pricingRuleTier.createMany({
            data: tiers.map((t, i) => ({
              pricingRuleId: id,
              costMin: t.costMin,
              costMax: t.costMax ?? null,
              percentValue: t.percentValue,
              sortOrder: t.sortOrder ?? i,
            })),
          });
        }
        if (scope.goodIds !== undefined || dropGoods) {
          await tx.pricingRuleGood.deleteMany({ where: { orgId, pricingRuleId: id } });
          await this.writeGoods(tx, orgId, id, scope.goodIds ?? []);
        }
        await tx.pricingRule.updateMany({
          where: { id, orgId, deletedAt: null },
          data: updateData,
        });
        const saved = await tx.pricingRule.findFirstOrThrow({
          where: { id, orgId },
          include: PRICING_RULE_INCLUDE,
        });
        const deadLists = await this.listsOfDeletedGoods(tx, orgId, [saved]);
        return { saved, deadList: deadLists.has(id) };
      },
      { timeout: 20_000 },
    );
    // У журнал — кількість товарів, а не тисячі id.
    const { goodIds: _ids, ...audited } = dto;
    this.auditRule(orgId, id, 'UPDATE', userId, undefined, {
      ...audited,
      ...(goodIds !== undefined ? { goodsCount: goodIds.length } : {}),
    });
    return this.toDto(rule.saved, rule.deadList);
  }

  async remove(orgId: string, userId: string | undefined, id: string): Promise<void> {
    // updateMany з orgId — defense-in-depth tenant guard для soft-delete.
    const res = await this.prisma.pricingRule.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (res.count === 0)
      throw new NotFoundException(translateError('err.pricingRule.notFound', getLocale()));
    this.auditRule(orgId, id, 'DELETE', userId, { id }, undefined);
  }

  async applyAll(orgId: string, id: string): Promise<ApplyPricingRuleResultDto> {
    const existing = await this.prisma.pricingRule.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!existing)
      throw new NotFoundException(translateError('err.pricingRule.notFound', getLocale()));
    const updated = await this.pricingService.applyRuleToGoods(orgId, id);
    return { updated, message: `Перераховано ${updated} товарів` };
  }

  /**
   * Область правила — ОДИН вимір: список товарів > бренд > категорія > тип > весь асортимент.
   * Точніший вимір очищає загальніші (BR-GOOD-009): інакше правило «бренд + категорія» читалося б
   * по-різному в резолвері й у «Застосувати до всіх» (Bug #178).
   */
  private normalizeScope(scope: RuleScope): RuleScope {
    if (scope.hasGoods)
      return { ...scope, brandId: null, goodCategoryId: null, goodCategory: null, goodType: null };
    if (scope.brandId)
      return { ...scope, goodCategoryId: null, goodCategory: null, goodType: null };
    if (scope.goodCategoryId) return { ...scope, goodCategory: null, goodType: null };
    if (scope.goodCategory) return { ...scope, goodType: null };
    return scope;
  }

  /** Товари, категорія, бренд і постачальник мусять бути живими записами ЦІЄЇ організації. */
  private async assertRefs(
    db: Prisma.TransactionClient,
    orgId: string,
    scope: RuleScope,
    supplierId: string | null,
  ): Promise<void> {
    const goodIds = scope.goodIds ?? [];
    const [foundGoods, category, brand, supplier] = await Promise.all([
      this.countGoods(db, orgId, goodIds),
      scope.goodCategoryId
        ? db.goodCategory.findFirst({
            where: { id: scope.goodCategoryId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      scope.brandId
        ? db.brand.findFirst({
            where: { id: scope.brandId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      supplierId
        ? db.counterparty.findFirst({
            where: { id: supplierId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    const locale = getLocale();
    if (foundGoods !== goodIds.length)
      throw new NotFoundException(
        goodIds.length === 1
          ? translateError('err.pricingRule.goodNotFound', locale)
          : translateError('err.pricingRule.goodsNotFound', locale, {
              count: goodIds.length - foundGoods,
            }),
      );
    if (scope.goodCategoryId && !category)
      throw new NotFoundException(translateError('err.pricingRule.categoryNotFound', locale));
    if (scope.brandId && !brand)
      throw new NotFoundException(translateError('err.pricingRule.brandNotFound', locale));
    if (supplierId && !supplier)
      throw new NotFoundException(translateError('err.pricingRule.supplierNotFound', locale));
  }

  /**
   * Правила, чий список складається ЛИШЕ з видалених товарів: лічильник живих 0, але рядки-зв'язки
   * є. Резолвер вважає таке правило правилом зі списком (ні на що не діє), тож таблиця не має
   * показувати його як бренд / категорію / «весь асортимент».
   */
  private async listsOfDeletedGoods(
    db: Prisma.TransactionClient,
    orgId: string,
    rules: Array<{ id: string; _count: { goods: number } }>,
  ): Promise<Set<string>> {
    const ids = rules.filter(r => r._count.goods === 0).map(r => r.id);
    const out = new Set<string>();
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const groups = await db.pricingRuleGood.groupBy({
        by: ['pricingRuleId'],
        where: { orgId, pricingRuleId: { in: ids.slice(i, i + IN_CHUNK) } },
      });
      for (const g of groups) out.add(g.pricingRuleId);
    }
    return out;
  }

  private async countGoods(
    db: Prisma.TransactionClient,
    orgId: string,
    goodIds: string[],
  ): Promise<number> {
    let found = 0;
    for (let i = 0; i < goodIds.length; i += IN_CHUNK) {
      found += await db.good.count({
        where: { orgId, deletedAt: null, id: { in: goodIds.slice(i, i + IN_CHUNK) } },
      });
    }
    return found;
  }

  private async writeGoods(
    tx: Prisma.TransactionClient,
    orgId: string,
    pricingRuleId: string,
    goodIds: string[],
  ): Promise<void> {
    if (goodIds.length === 0) return;
    await tx.pricingRuleGood.createMany({
      data: goodIds.map(goodId => ({ orgId, pricingRuleId, goodId })),
      skipDuplicates: true,
    });
  }

  /**
   * При зміні type старі value-поля (percentValue/fixedAmount/fixedPrice) можуть
   * залишатись у БД після перемикання в UI. Backend нормалізує: для обраного type
   * залишаємо лише релевантне поле, інші — undefined → не пишеться в Prisma.
   */
  private cleanValuesForType<
    T extends Partial<CreatePricingRuleDto> & Partial<UpdatePricingRuleDto>,
  >(dto: T): T {
    if (!dto.type) return dto;
    const out = { ...dto };
    switch (dto.type) {
      case 'PERCENT':
      case 'COMPETITOR_PLUS':
        out.fixedAmount = undefined;
        out.fixedPrice = undefined;
        break;
      case 'FIXED_AMOUNT':
        out.percentValue = undefined;
        out.fixedPrice = undefined;
        break;
      case 'FIXED_PRICE':
        out.percentValue = undefined;
        out.fixedAmount = undefined;
        break;
      case 'COST_TIER':
        out.percentValue = undefined;
        out.fixedAmount = undefined;
        out.fixedPrice = undefined;
        break;
    }
    return out;
  }

  private toGoodRef(good: RuleGood): PricingRuleGoodRefDto {
    return {
      id: good.id,
      internalCode: good.internalCode,
      name: good.name,
      sku: good.sku,
      brandName: good.brand?.name ?? null,
    };
  }

  /** `deadList` — список правила є, але всі його товари видалені (`listsOfDeletedGoods`). */
  private toDto(rule: PricingRuleWithRelations, deadList: boolean): PricingRuleResponseDto {
    const s = rule.supplier;
    const supplierName = s
      ? (s.companyName ?? [s.firstName, s.lastName].filter(Boolean).join(' ') ?? null)
      : null;
    return {
      id: rule.id,
      name: rule.name,
      type: rule.type,
      priority: rule.priority,
      goodsCount: rule._count.goods,
      hasGoodsList: rule._count.goods > 0 || deadList,
      goodsPreview: rule.goods.map(l => this.toGoodRef(l.good)),
      goodCategoryId: rule.goodCategoryId,
      goodCategoryName: rule.category?.name ?? null,
      goodCategory: rule.goodCategory,
      goodType: rule.goodType,
      brandId: rule.brandId ?? null,
      brandName: rule.brand?.name ?? null,
      supplierId: rule.supplierId ?? null,
      supplierName,
      percentValue: rule.percentValue != null ? Number(rule.percentValue) : null,
      fixedAmount: rule.fixedAmount != null ? Number(rule.fixedAmount) : null,
      fixedPrice: rule.fixedPrice != null ? Number(rule.fixedPrice) : null,
      roundTo: rule.roundTo != null ? Number(rule.roundTo) : null,
      isActive: rule.isActive,
      createdAt: rule.createdAt,
      tiers: rule.tiers.map(t => ({
        id: t.id,
        costMin: Number(t.costMin),
        costMax: t.costMax != null ? Number(t.costMax) : null,
        percentValue: Number(t.percentValue),
        sortOrder: t.sortOrder,
      })),
    };
  }
}
