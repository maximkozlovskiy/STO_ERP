import {
  Controller,
  Get,
  NotFoundException,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { BatchService } from './batch.service';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('Batches')
@Controller('batches')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class BatchesController {
  constructor(
    private readonly batchService: BatchService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('lookup')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'RECEPTIONIST', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Batch viewer: партії + цінова історія товару' })
  @ApiQuery({ name: 'goodId', required: true })
  @ApiQuery({ name: 'warehouseId', required: false })
  async lookup(
    @OrgContext() orgId: string,
    @Query('goodId', new ParseUUIDPipe()) goodId: string,
    @Query('warehouseId', new ParseUUIDPipe({ optional: true })) warehouseId?: string,
  ) {
    const [good, batches, priceHistory, avgCost] = await Promise.all([
      this.prisma.good.findFirst({
        where: { id: goodId, orgId, deletedAt: null },
        select: { id: true, name: true, sku: true, unit: true, salePrice: true },
      }),
      this.batchService.getBatchesForGood(orgId, goodId, warehouseId),
      this.prisma.priceHistory.findMany({
        where: { orgId, goodId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.batchService.getAvgCost(orgId, goodId, warehouseId),
    ]);

    if (!good) throw new NotFoundException('Товар не знайдено');

    return {
      good: { ...good, salePrice: Number(good.salePrice) },
      avgCostPrice: avgCost,
      batches,
      priceHistory: priceHistory.map(h => ({
        id: h.id,
        oldPrice: h.oldPrice != null ? Number(h.oldPrice) : null,
        newPrice: Number(h.newPrice),
        costPrice: h.costPrice != null ? Number(h.costPrice) : null,
        reason: h.reason,
        createdAt: h.createdAt,
      })),
    };
  }
}
