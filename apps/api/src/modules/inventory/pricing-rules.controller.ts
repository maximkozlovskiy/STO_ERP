import {
  Controller, Get, Post, Patch, Delete, Body, Param, ParseUUIDPipe, UseGuards, HttpCode,
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
  tiers: PricingRuleTier[];
};

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
  async findAll(@OrgContext() orgId: string) {
    // Bug #17: правила, прив'язані до soft-deleted Good — приховуємо.
    // Bug #18: повертаємо paginated shape { items, total, page, limit } для відповідності API-контракту.
    const where: Prisma.PricingRuleWhereInput = {
      orgId,
      deletedAt: null,
      OR: [
        { goodId: null },
        { good: { deletedAt: null } },
      ],
    };
    const [rules, total] = await this.prisma.$transaction([
      this.prisma.pricingRule.findMany({
        where,
        include: {
          good: { select: { id: true, name: true, sku: true } },
          brand: { select: { id: true, name: true } },
          tiers: { orderBy: { sortOrder: 'asc' } },
        },
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
    // If goodId is provided, verify it belongs to the same org (prevent cross-tenant rule attachment)
    if (dto.goodId) {
      const good = await this.prisma.good.findFirst({
        where: { id: dto.goodId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!good) throw new NotFoundException('Товар не знайдено');
    }
    // Validate brandId belongs to same org
    if (dto.brandId) {
      const brand = await this.prisma.brand.findFirst({
        where: { id: dto.brandId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!brand) throw new NotFoundException('Бренд не знайдено');
    }
    // Bug #22: scope-поля взаємовиключні, ієрархія goodId > goodCategory > goodType.
    // Очищаємо менш специфічні рівні, щоб менеджер не зберігав суперечливі правила.
    const normalized = this.normalizeScope(dto);
    // Bug #23 echo: backend очищає поля values, які не належать обраному type.
    const cleanValues = this.cleanValuesForType(normalized);
    const { tiers, ...ruleData } = cleanValues;
    const rule = await this.prisma.pricingRule.create({
      data: {
        orgId,
        ...ruleData,
        priority: ruleData.priority ?? 10,
        ...(tiers && tiers.length > 0 ? {
          tiers: { createMany: { data: tiers.map((t, i) => ({
            costMin: t.costMin,
            costMax: t.costMax ?? null,
            percentValue: t.percentValue,
            sortOrder: t.sortOrder ?? i,
          })) } },
        } : {}),
      },
      include: {
        good: { select: { id: true, name: true, sku: true } },
        brand: { select: { id: true, name: true } },
        tiers: { orderBy: { sortOrder: 'asc' } },
      },
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
    const existing = await this.prisma.pricingRule.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Правило не знайдено');

    // If goodId is being changed, verify the new value belongs to the same org
    // (prevent cross-tenant rule attachment via update)
    if (dto.goodId) {
      const good = await this.prisma.good.findFirst({
        where: { id: dto.goodId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!good) throw new NotFoundException('Товар не знайдено');
    }
    // Validate brandId belongs to same org
    if (dto.brandId) {
      const brand = await this.prisma.brand.findFirst({
        where: { id: dto.brandId, orgId, deletedAt: null },
        select: { id: true },
      });
      if (!brand) throw new NotFoundException('Бренд не знайдено');
    }

    // Bug #35: PATCH повинен застосовувати ієрархію scope з урахуванням існуючого
    // стану. Якщо клієнт надсилає лише `goodCategory` (без явного `goodId: null`),
    // а в БД вже встановлено `goodId` — після `normalizeScope(dto)` бачимо лише
    // нові поля і `goodId` залишається старим → суперечливий стан goodId+goodCategory.
    // Merge існуючого з dto перед нормалізацією — забезпечує self-consistent контракт.
    const mergedScope = {
      goodId: dto.goodId !== undefined ? dto.goodId : existing.goodId,
      goodCategory: dto.goodCategory !== undefined ? dto.goodCategory : existing.goodCategory,
      goodType: dto.goodType !== undefined ? dto.goodType : existing.goodType ?? undefined,
    };
    const merged = { ...dto, ...mergedScope } as UpdatePricingRuleDto;
    const normalized = this.normalizeScope(merged);
    const cleanValues = this.cleanValuesForType(normalized);

    // Explicitly null out scope fields що були "пониззані" нормалізацією,
    // інакше Prisma update лишить старі значення в БД.
    // Використовуємо UncheckedUpdateInput, бо `goodId` — це foreign key поле без relation-обгортки.
    const { tiers, ...restValues } = cleanValues;
    const updateData: Prisma.PricingRuleUncheckedUpdateInput = {
      ...restValues,
      goodId: normalized.goodId ?? null,
      goodCategory: normalized.goodCategory ?? null,
      goodType: normalized.goodType ?? null,
      brandId: dto.brandId !== undefined ? (dto.brandId ?? null) : existing.brandId,
    };

    // Replace-semantics for tiers: deleteMany + createMany in $transaction
    let rule;
    if (tiers !== undefined) {
      rule = await this.prisma.$transaction(async (tx) => {
        await tx.pricingRuleTier.deleteMany({ where: { pricingRuleId: id } });
        if (tiers.length > 0) {
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
        return tx.pricingRule.update({
          where: { id },
          data: updateData,
          include: {
            good: { select: { id: true, name: true, sku: true } },
            brand: { select: { id: true, name: true } },
            tiers: { orderBy: { sortOrder: 'asc' } },
          },
        });
      }, { timeout: 10_000 });
    } else {
      rule = await this.prisma.pricingRule.update({
        where: { id },
        data: updateData,
        include: {
          good: { select: { id: true, name: true, sku: true } },
          brand: { select: { id: true, name: true } },
          tiers: { orderBy: { sortOrder: 'asc' } },
        },
      });
    }
    return this.toDto(rule);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @HttpCode(204)
  @ApiOperation({ summary: 'Видалити правило ціноутворення' })
  async remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    const existing = await this.prisma.pricingRule.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Правило не знайдено');
    await this.prisma.pricingRule.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
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
   * Bug #22: Scope-поля взаємовиключні. Ієрархія: goodId > goodCategory > goodType > all.
   * Якщо вказано goodId — обнуляємо goodCategory і goodType.
   * Якщо вказано goodCategory (без goodId) — обнуляємо goodType.
   */
  private normalizeScope<T extends Partial<CreatePricingRuleDto> & Partial<UpdatePricingRuleDto>>(dto: T): T {
    const clone = { ...dto };
    if (clone.goodId) {
      clone.goodCategory = undefined;
      clone.goodType = undefined;
    } else if (clone.goodCategory) {
      clone.goodType = undefined;
    }
    return clone;
  }

  /**
   * Bug #23: При зміні type старі value-поля (percentValue/fixedAmount/fixedPrice) можуть
   * залишатись у БД після перемикання в UI. Backend нормалізує: для обраного type
   * залишаємо лише релевантне поле, інші — undefined → не пишеться в Prisma.
   */
  private cleanValuesForType<T extends Partial<CreatePricingRuleDto> & Partial<UpdatePricingRuleDto>>(dto: T): T {
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
