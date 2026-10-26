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
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PricingRulesService } from './pricing-rules.service';
import {
  ApplyPricingRuleResultDto,
  CreatePricingRuleDto,
  PaginatedPricingRulesDto,
  PricingRuleGoodsDto,
  PricingRuleResponseDto,
  UpdatePricingRuleDto,
} from './pricing-rules.dto';
import { UserRole } from '@prisma/client';

@ApiTags('Pricing Rules')
@Controller('pricing-rules')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class PricingRulesController {
  constructor(private readonly service: PricingRulesService) {}

  @Get()
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.STOREKEEPER)
  @ApiOperation({ summary: 'Список правил ціноутворення' })
  @ApiOkResponse({ type: PaginatedPricingRulesDto })
  async findAll(
    @OrgContext() orgId: string,
    @Query('supplierId', new ParseUUIDPipe({ optional: true })) supplierId?: string,
  ) {
    // supplierId uses ParseUUIDPipe so arbitrary strings (`?supplierId=DROP TABLE`) are rejected
    // before reaching Prisma WHERE.
    return this.service.findAll(orgId, supplierId);
  }

  // Суброут ПЕРЕД `:id` (Fastify матчить у порядку оголошення).
  @Get(':id/goods')
  @Roles(UserRole.OWNER, UserRole.ADMIN, UserRole.STOREKEEPER)
  @ApiOperation({ summary: 'Повний список товарів правила' })
  @ApiOkResponse({ type: PricingRuleGoodsDto })
  async findGoods(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PricingRuleGoodsDto> {
    return this.service.findGoods(orgId, id);
  }

  @Post()
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Створити правило ціноутворення' })
  @ApiCreatedResponse({ type: PricingRuleResponseDto })
  async create(
    @OrgContext() orgId: string,
    @CurrentUser() user: { id: string },
    @Body() dto: CreatePricingRuleDto,
  ) {
    return this.service.create(orgId, user?.id, dto);
  }

  @Patch(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Оновити правило ціноутворення' })
  @ApiOkResponse({ type: PricingRuleResponseDto })
  async update(
    @OrgContext() orgId: string,
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePricingRuleDto,
  ) {
    return this.service.update(orgId, user?.id, id, dto);
  }

  @Delete(':id')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @HttpCode(204)
  @ApiOperation({ summary: 'Видалити правило ціноутворення' })
  @ApiNoContentResponse()
  async remove(
    @OrgContext() orgId: string,
    @CurrentUser() user: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.remove(orgId, user?.id, id);
  }

  @Post(':id/apply-all')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Застосувати правило до всіх відповідних товарів' })
  @ApiOkResponse({ type: ApplyPricingRuleResultDto })
  async applyAll(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ApplyPricingRuleResultDto> {
    return this.service.applyAll(orgId, id);
  }
}
