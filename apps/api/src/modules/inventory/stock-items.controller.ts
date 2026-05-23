import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { InventoryService } from './inventory.service';

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
    @Query('warehouseId') warehouseId?: string,
    @Query('goodId') goodId?: string,
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
}
