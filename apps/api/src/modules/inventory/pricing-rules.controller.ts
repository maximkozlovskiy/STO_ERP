import {
  Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, HttpCode,
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
import { UserRole, PricingRule } from '@prisma/client';

type PricingRuleWithGood = PricingRule & {
  good: { id: string; name: string; sku: string | null } | null;
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
    const rules = await this.prisma.pricingRule.findMany({
      where: { orgId, deletedAt: null },
      include: { good: { select: { id: true, name: true, sku: true } } },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      take: 200,
    });
    return rules.map(r => this.toDto(r));
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
    const rule = await this.prisma.pricingRule.create({
      data: { orgId, ...dto, priority: dto.priority ?? 10 },
      include: { good: { select: { id: true, name: true, sku: true } } },
    });
    return this.toDto(rule);
  }

  @Patch(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Оновити правило ціноутворення' })
  async update(
    @OrgContext() orgId: string,
    @Param('id') id: string,
    @Body() dto: UpdatePricingRuleDto,
  ) {
    const existing = await this.prisma.pricingRule.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Правило не знайдено');

    const rule = await this.prisma.pricingRule.update({
      where: { id },
      data: dto,
      include: { good: { select: { id: true, name: true, sku: true } } },
    });
    return this.toDto(rule);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @HttpCode(204)
  @ApiOperation({ summary: 'Видалити правило ціноутворення' })
  async remove(@OrgContext() orgId: string, @Param('id') id: string) {
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
  async applyAll(@OrgContext() orgId: string, @Param('id') id: string) {
    const existing = await this.prisma.pricingRule.findFirst({
      where: { id, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Правило не знайдено');
    const updated = await this.pricingService.applyRuleToGoods(orgId, id);
    return { updated, message: `Перераховано ${updated} товарів` };
  }

  private toDto(rule: PricingRuleWithGood) {
    return {
      id: rule.id,
      name: rule.name,
      type: rule.type,
      priority: rule.priority,
      goodId: rule.goodId,
      good: rule.good ?? null,
      goodCategory: rule.goodCategory,
      goodType: rule.goodType,
      percentValue: rule.percentValue != null ? Number(rule.percentValue) : null,
      fixedAmount: rule.fixedAmount != null ? Number(rule.fixedAmount) : null,
      fixedPrice: rule.fixedPrice != null ? Number(rule.fixedPrice) : null,
      roundTo: rule.roundTo != null ? Number(rule.roundTo) : null,
      isActive: rule.isActive,
      createdAt: rule.createdAt,
    };
  }
}
