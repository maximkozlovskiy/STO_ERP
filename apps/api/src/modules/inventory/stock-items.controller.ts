import { Controller, Get, Patch, Query, Param, Body, UseGuards, ParseUUIDPipe } from '@nestjs/common';
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
