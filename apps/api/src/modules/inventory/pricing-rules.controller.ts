import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { PricingService } from './pricing.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePricingRuleDto, UpdatePricingRuleDto } from './pricing-rules.dto';
import { NotFoundException } from '@nestjs/common';
import { UserRole, PricingRule, PricingRuleTier, Prisma } from '@prisma/client';

type PricingRuleWithRelations = PricingRule & {
  good: { id: string; name: string; sku: string | null } | null;
  brand: { id: string; name: string } | null;
  supplier: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
  } | null;
  tiers: PricingRuleTier[];
};

// sto-review §13 + accumulated pattern (2026-06-19, relation-include drift):
// один shared include shape для findAll/create/update — гарантує, що додавання
// нового scalar (наприклад good.internalCode) не оминає жоден з 4 endpoints.
const PRICING_RULE_INCLUDE = {
  good: { select: { id: true, name: true, sku: true } },
  brand: { select: { id: true, name: true } },
  supplier: { select: { id: true, firstName: true, lastName: true, companyName: true } },
  tiers: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.PricingRuleInclude;

@ApiTags('Pricing Rules')
@Controller('pricing-rules')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class PricingRulesController {
  constructor(
    private readonly pricingService: PricingService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.STOREKEEPER)
  @ApiOperation({ summary: 'Список правил ціноутворення' })
  async findAll(
    @OrgContext() orgId: string,
    @Query('supplierId', new ParseUUIDPipe({ optional: true })) supplierId?: string,
  ) {
    // Rules linked to soft-deleted Goods are hidden (OR: goodId=null | good.deletedAt=null).
    // supplierId uses ParseUUIDPipe so arbitrary strings (`?supplierId=DROP TABLE`) are rejected
    // before reaching Prisma WHERE. orgId filter ensures a malicious UUID from another org
    // returns 0 rows even if the supplierId exists there.
    const where: Prisma.PricingRuleWhereInput = {
      orgId,
      deletedAt: null,
      OR: [{ goodId: null }, { good: { deletedAt: null } }],
      ...(supplierId ? { supplierId } : {}),
    };
    const [rules, total] = await this.prisma.$transaction([
      this.prisma.pricingRule.findMany({
        where,
        include: PRICING_RULE_INCLUDE,
        orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
        take: 200,
      }),
      this.prisma.pricingRule.count({ where }),
    ]);
    return {
      items: rules.map(r => this.toDto(r)),
      total,
      page: 1,
      limit: 200,
    };
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Створити правило ціноутворення' })
  async create(@OrgContext() orgId: string, @Body() dto: CreatePricingRuleDto) {
    // Parallel FK validation: goodId + brandId + supplierId — всі незалежні.
    const [good, brand, supplier] = await Promise.all([
      dto.goodId
        ? this.prisma.good.findFirst({
            where: { id: dto.goodId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.brandId
        ? this.prisma.brand.findFirst({
            where: { id: dto.brandId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.supplierId
        ? this.prisma.counterparty.findFirst({
            where: { id: dto.supplierId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    if (dto.goodId && !good) throw new NotFoundException('Товар не знайдено');
    if (dto.brandId && !brand) throw new NotFoundException('Бренд не знайдено');
    if (dto.supplierId && !supplier) throw new NotFoundException('Постачальника не знайдено');
    const normalized = this.normalizeScope(dto);
    const cleanValues = this.cleanValuesForType(normalized);
    const { tiers, ...ruleData } = cleanValues;
    const rule = await this.prisma.pricingRule.create({
      data: {
        orgId,
        ...ruleData,
        priority: ruleData.priority ?? 10,
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
      include: PRICING_RULE_INCLUDE,
    });
    return this.toDto(rule);
  }

  @Patch(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Оновити правило ціноутворення' })
  async update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePricingRuleDto,
  ) {
    // Parallel: tenant guard (existing) + FK validation (goodId + brandId + supplierId).
    // existing.orgId перевірений у where, решта — окремі таблиці, всі незалежні.
    const [existing, good, brand, supplier] = await Promise.all([
      this.prisma.pricingRule.findFirst({ where: { id, orgId, deletedAt: null } }),
      dto.goodId
        ? this.prisma.good.findFirst({
            where: { id: dto.goodId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.brandId
        ? this.prisma.brand.findFirst({
            where: { id: dto.brandId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
      dto.supplierId
        ? this.prisma.counterparty.findFirst({
            where: { id: dto.supplierId, orgId, deletedAt: null },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    if (!existing) throw new NotFoundException('Правило не знайдено');
    if (dto.goodId && !good) throw new NotFoundException('Товар не знайдено');
    if (dto.brandId && !brand) throw new NotFoundException('Бренд не знайдено');
    if (dto.supplierId && !supplier) throw new NotFoundException('Постачальника не знайдено');

    // PATCH must apply scope hierarchy considering existing
    // стану. Якщо клієнт надсилає лише `goodCategory` (без явного `goodId: null`),
    // а в БД вже встановлено `goodId` — після `normalizeScope(dto)` бачимо лише
    // нові поля і `goodId` залишається старим → суперечливий стан goodId+goodCategory.
    // Merge існуючого з dto перед нормалізацією — забезпечує self-consistent контракт.
    const mergedScope = {
      goodId: dto.goodId !== undefined ? dto.goodId : existing.goodId,
      brandId: dto.brandId !== undefined ? dto.brandId : (existing.brandId ?? undefined),
      goodCategory: dto.goodCategory !== undefined ? dto.goodCategory : existing.goodCategory,
      goodType: dto.goodType !== undefined ? dto.goodType : (existing.goodType ?? undefined),
      supplierId:
        dto.supplierId !== undefined ? dto.supplierId : (existing.supplierId ?? undefined),
    };
    const merged = { ...dto, ...mergedScope } as UpdatePricingRuleDto;
    const normalized = this.normalizeScope(merged);
    const cleanValues = this.cleanValuesForType(normalized);

    // Explicitly null out scope fields що були "пониззані" нормалізацією,
    // інакше Prisma update лишить старі значення в БД.
    // Використовуємо UncheckedUpdateInput, бо `goodId` — це foreign key поле без relation-обгортки.
    //
    // CRITICAL: брати brandId з normalized (після normalizeScope), а не з existing.
    // Без цього при PATCH { goodId: 'g1' } на правилі з brandId='b1' нормалізація
    // очищає brandId до undefined, але БД зберігає старий 'b1' → goodId+brandId одночасно,
    // що порушує взаємну виключність scope-полів.
    const { tiers, ...restValues } = cleanValues;
    const updateData: Prisma.PricingRuleUncheckedUpdateInput = {
      ...restValues,
      goodId: normalized.goodId ?? null,
      brandId: normalized.brandId ?? null,
      goodCategory: normalized.goodCategory ?? null,
      goodType: normalized.goodType ?? null,
      supplierId: normalized.supplierId ?? null,
    };

    // Replace-semantics for tiers: deleteMany + createMany in $transaction.
    // Якщо тип змінено НЕ на COST_TIER — старі тіри стають mertvim вантажем (не використовуються,
    // але засмічують БД і "відроджуються" якщо користувач переключиться назад на COST_TIER).
    // → видаляємо їх явно при будь-якій зміні типу з COST_TIER.
    const switchedAwayFromCostTier =
      normalized.type !== undefined &&
      normalized.type !== 'COST_TIER' &&
      existing.type === 'COST_TIER';
    const needsTierTx = tiers !== undefined || switchedAwayFromCostTier;

    let rule;
    if (needsTierTx) {
      rule = await this.prisma.$transaction(
        async tx => {
          // sto-optimize: pricing_rules.updateMany пишеться у ОКРЕМУ таблицю від
          // pricing_rule_tiers (deleteMany+createMany), тому головний update може
          // йти ПАРАЛЕЛЬНО з tier-sequence. Tiers тут зберігають ВНУТРІШНІЙ порядок
          // (delete МУСИТЬ передувати create), але pricingRule.updateMany не залежить
          // від результату жодної з них. Паттерн "Disjoint-set updateMany pairs".
          const tierWork = (async () => {
            if (tiers !== undefined || switchedAwayFromCostTier) {
              // Tier-deleteMany is org-trusted (pricingRule existing org-checked),
              // але tiers не мають власного orgId — фільтр по pricingRuleId безпечний.
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
          })();
          // updateMany з orgId — defense-in-depth tenant guard.
          // existing.org вже перевірений вище, але дублюємо щоб патерн був безпечним для копіювання
          // і виключаємо випадок коли інший запит soft-delete-нув правило між findFirst і update.
          const mainUpdate = tx.pricingRule.updateMany({
            where: { id, orgId, deletedAt: null },
            data: updateData,
          });
          await Promise.all([tierWork, mainUpdate]);
          return tx.pricingRule.findFirstOrThrow({
            where: { id, orgId },
            include: PRICING_RULE_INCLUDE,
          });
        },
        { timeout: 10_000 },
      );
    } else {
      // updateMany з orgId — defense-in-depth.
      await this.prisma.pricingRule.updateMany({
        where: { id, orgId, deletedAt: null },
        data: updateData,
      });
      rule = await this.prisma.pricingRule.findFirstOrThrow({
        where: { id, orgId },
        include: PRICING_RULE_INCLUDE,
      });
    }
    return this.toDto(rule);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @HttpCode(204)
  @ApiOperation({ summary: 'Видалити правило ціноутворення' })
  async remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    // updateMany з orgId — defense-in-depth tenant guard для soft-delete.
    const res = await this.prisma.pricingRule.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (res.count === 0) throw new NotFoundException('Правило не знайдено');
  }

  @Post(':id/apply-all')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Застосувати правило до всіх відповідних товарів' })
  async applyAll(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    const existing = await this.prisma.pricingRule.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Правило не знайдено');
    const updated = await this.pricingService.applyRuleToGoods(orgId, id);
    return { updated, message: `Перераховано ${updated} товарів` };
  }

  /**
   * Scope fields are mutually exclusive: Ієрархія: goodId > goodCategory > goodType > all.
   * Якщо вказано goodId — обнуляємо goodCategory і goodType.
   * Якщо вказано goodCategory (без goodId) — обнуляємо goodType.
   */
  private normalizeScope<T extends Partial<CreatePricingRuleDto> & Partial<UpdatePricingRuleDto>>(
    dto: T,
  ): T {
    const clone = { ...dto };
    if (clone.goodId) {
      // goodId (priority 1) — clear all lower-priority scope fields
      clone.brandId = undefined;
      clone.goodCategory = undefined;
      clone.goodType = undefined;
    } else if (clone.brandId) {
      // brandId (priority 2) — clear lower-priority scope fields
      clone.goodCategory = undefined;
      clone.goodType = undefined;
    } else if (clone.goodCategory) {
      // goodCategory (priority 3) — clear goodType
      clone.goodType = undefined;
    }
    return clone;
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

  private toDto(rule: PricingRuleWithRelations) {
    const s = rule.supplier;
    const supplierName = s
      ? (s.companyName ?? [s.firstName, s.lastName].filter(Boolean).join(' ') ?? null)
      : null;
    return {
      id: rule.id,
      name: rule.name,
      type: rule.type,
      priority: rule.priority,
      goodId: rule.goodId,
      good: rule.good ?? null,
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
