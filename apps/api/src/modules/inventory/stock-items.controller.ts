import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('Stock Items')
@Controller('stock-items')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class StockItemsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Залишки по складах' })
  @ApiQuery({ name: 'warehouseId', required: false })
  @ApiQuery({ name: 'goodId', required: false })
  @ApiQuery({ name: 'q', required: false })
  async findAll(
    @OrgContext() orgId: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('goodId') goodId?: string,
    @Query('q') q?: string,
  ) {
    const where: any = { orgId };
    if (warehouseId) where.warehouseId = warehouseId;
    if (goodId) where.goodId = goodId;
    if (q) where.good = { name: { contains: q, mode: 'insensitive' } };

    const items = await this.prisma.stockItem.findMany({
      where,
      include: {
        good: { select: { id: true, name: true, sku: true, unit: true, salePrice: true } },
        warehouse: { select: { id: true, name: true } },
      },
      orderBy: [{ warehouse: { name: 'asc' } }, { good: { name: 'asc' } }],
    });

    return items.map(i => ({
      id: i.id,
      goodId: i.goodId,
      goodName: i.good.name,
      goodSku: i.good.sku,
      unit: i.good.unit,
      salePrice: Number(i.good.salePrice),
      warehouseId: i.warehouseId,
      warehouseName: i.warehouse.name,
      quantity: i.quantity,
      reserved: i.reserved,
      available: i.quantity - i.reserved,
      minStock: i.minStock ?? null,
      isLow: i.minStock != null && i.quantity <= i.minStock,
    }));
  }

  @Get('low')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Товари нижче мінімального залишку' })
  async findLow(@OrgContext() orgId: string) {
    const items = await this.prisma.stockItem.findMany({
      where: { orgId, minStock: { not: null } },
      include: {
        good: { select: { id: true, name: true, sku: true, unit: true } },
        warehouse: { select: { id: true, name: true } },
      },
    });

    return items
      .filter(i => i.quantity <= (i.minStock ?? 0))
      .map(i => ({
        goodId: i.goodId,
        goodName: i.good.name,
        goodSku: i.good.sku,
        unit: i.good.unit,
        warehouseName: i.warehouse.name,
        quantity: i.quantity,
        minStock: i.minStock,
        deficit: (i.minStock ?? 0) - i.quantity,
      }));
  }
}
