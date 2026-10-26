import { Controller, Get, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { BatchService } from './batch.service';

@ApiTags('Batches')
@Controller('batches')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class BatchesController {
  constructor(private readonly batchService: BatchService) {}

  @Get('lookup')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'RECEPTIONIST', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Batch viewer: партії + цінова історія товару' })
  @ApiQuery({ name: 'goodId', required: true })
  @ApiQuery({ name: 'warehouseId', required: false })
  lookup(
    @OrgContext() orgId: string,
    @Query('goodId', new ParseUUIDPipe()) goodId: string,
    @Query('warehouseId', new ParseUUIDPipe({ optional: true })) warehouseId?: string,
  ) {
    return this.batchService.lookup(orgId, goodId, warehouseId);
  }
}
