import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { ReportsService } from './reports.service';

@ApiTags('Reports')
@Controller('reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  @Get('revenue')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Виручка по днях' })
  @ApiQuery({ name: 'from', required: true, example: '2026-01-01' })
  @ApiQuery({ name: 'to', required: true, example: '2026-12-31' })
  @ApiQuery({ name: 'branchId', required: false })
  revenue(
    @OrgContext() orgId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.service.revenue(orgId, from, to, branchId);
  }

  @Get('work-orders')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Наряди по механіках та часу' })
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  @ApiQuery({ name: 'employeeId', required: false })
  workOrders(
    @OrgContext() orgId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('employeeId') employeeId?: string,
  ) {
    return this.service.workOrders(orgId, from, to, employeeId);
  }

  @Get('stock')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Залишки та рухи по складу' })
  @ApiQuery({ name: 'warehouseId', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  stock(
    @OrgContext() orgId: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.service.stock(orgId, warehouseId, from, to);
  }

  @Get('profitability')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Рентабельність (виручка vs собівартість)' })
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  profitability(
    @OrgContext() orgId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.service.profitability(orgId, from, to);
  }

  @Get('settlements')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Дебіторська / кредиторська заборгованість' })
  @ApiQuery({ name: 'counterpartyId', required: false })
  settlements(
    @OrgContext() orgId: string,
    @Query('counterpartyId') counterpartyId?: string,
  ) {
    return this.service.settlements(orgId, counterpartyId);
  }

  @Get('load')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Завантаженість підйомників' })
  @ApiQuery({ name: 'branchId', required: false })
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  load(
    @OrgContext() orgId: string,
    @Query('branchId') branchId: string | undefined,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.service.load(orgId, from, to, branchId);
  }
}
