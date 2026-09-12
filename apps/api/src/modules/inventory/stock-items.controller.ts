import {
  Controller,
  Get,
  Patch,
  Query,
  Param,
  Body,
  UseGuards,
  ParseUUIDPipe,
  BadRequestException,
} from '@nestjs/common';
import { StockMovementType } from '@prisma/client';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, Min } from 'class-validator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { InventoryService } from './inventory.service';

class UpdateMinStockDto {
  @ApiProperty({ nullable: true, required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minStock?: number | null;
}

@ApiTags('Stock Items')
@Controller('stock-items')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class StockItemsController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Залишки по складах' })
  @ApiQuery({ name: 'warehouseId', required: false })
  @ApiQuery({ name: 'goodId', required: false })
  @ApiQuery({ name: 'q', required: false })
  findAll(
    @OrgContext() orgId: string,
    @Query('warehouseId', new ParseUUIDPipe({ optional: true })) warehouseId?: string,
    @Query('goodId', new ParseUUIDPipe({ optional: true })) goodId?: string,
    @Query('q') q?: string,
  ) {
    return this.inventory.findStockItems(orgId, warehouseId, goodId, q);
  }

  @Get('low')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Товари нижче мінімального залишку' })
  findLow(@OrgContext() orgId: string) {
    return this.inventory.findLowStockItems(orgId);
  }

  // Specific sub-routes BEFORE :id — Fastify matches in declaration order
  @Get('by-document')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'RECEPTIONIST', 'MECHANIC')
  @ApiOperation({ summary: 'Залишки по документах (товар → рухи по документах)' })
  @ApiQuery({ name: 'warehouseId', required: false })
  @ApiQuery({ name: 'goodId', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  byDocument(
    @OrgContext() orgId: string,
    @Query('warehouseId', new ParseUUIDPipe({ optional: true })) warehouseId?: string,
    @Query('goodId', new ParseUUIDPipe({ optional: true })) goodId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.inventory.byDocument(orgId, warehouseId, goodId, from, to);
  }

  @Get('by-batch')
  // MECHANIC excluded — response includes batch.costPrice/salePrice. Pricing
  // exposure is restricted to OWNER/ADMIN/STOREKEEPER/ACCOUNTANT/RECEPTIONIST
  // (RECEPTIONIST already sees salePrice on the goods-list endpoint).
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Залишки по партіях (партія → товар → рухи)' })
  @ApiQuery({ name: 'warehouseId', required: false })
  @ApiQuery({ name: 'goodId', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  byBatch(
    @OrgContext() orgId: string,
    @Query('warehouseId', new ParseUUIDPipe({ optional: true })) warehouseId?: string,
    @Query('goodId', new ParseUUIDPipe({ optional: true })) goodId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.inventory.byBatch(orgId, warehouseId, goodId, from, to);
  }

  @Get('movements')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Журнал рухів складу (плоский, з фільтрами + пагінація)' })
  @ApiQuery({ name: 'warehouseId', required: false })
  @ApiQuery({ name: 'goodId', required: false })
  @ApiQuery({ name: 'type', required: false, enum: StockMovementType })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  movements(
    @OrgContext() orgId: string,
    @Query('warehouseId', new ParseUUIDPipe({ optional: true })) warehouseId?: string,
    @Query('goodId', new ParseUUIDPipe({ optional: true })) goodId?: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    // Валідація type проти enum (невідоме значення → 400, не тихий ігнор/500).
    // hasOwnProperty, а не `in` — `in` резолвить прототипні ключі (constructor/toString/
    // valueOf/hasOwnProperty), тож `?type=constructor` пройшов би guard → долетів би до
    // Prisma enum-колонки → P2009 invalid enum → HTTP 500 (не-i18n, Sentry-шум) замість 400.
    if (type && !Object.prototype.hasOwnProperty.call(StockMovementType, type)) {
      throw new BadRequestException('Невідомий тип руху');
    }
    return this.inventory.findMovements(orgId, {
      goodId,
      warehouseId,
      type: type as StockMovementType | undefined,
      from,
      to,
      page: page != null ? Number(page) : undefined,
      limit: limit != null ? Number(limit) : undefined,
    });
  }

  @Patch(':id/min-stock')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Встановити мінімальний залишок' })
  updateMinStock(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMinStockDto,
  ) {
    return this.inventory.updateMinStock(orgId, id, dto.minStock ?? null);
  }
}
