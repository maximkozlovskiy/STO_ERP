import { Controller, Get, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiOkResponse } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import {
  assertCalendarDateQuery,
  assertRequiredCalendarDateQuery,
} from '../../common/utils/date-query';
import { ReportsService } from './reports.service';
import {
  LoadReportDto,
  ProfitabilityReportDto,
  RevenueReportDto,
  SettlementsReportDto,
  StockReportDto,
  VatReportDto,
  WorkOrdersReportDto,
} from './reports.dto';

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
  @ApiOkResponse({ type: RevenueReportDto })
  revenue(
    @OrgContext() orgId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId?: string,
  ): Promise<RevenueReportDto> {
    assertRequiredCalendarDateQuery(from, to);
    return this.service.revenue(orgId, from, to, branchId);
  }

  @Get('work-orders')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Наряди по механіках та часу' })
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  @ApiQuery({ name: 'employeeId', required: false })
  @ApiOkResponse({ type: WorkOrdersReportDto })
  workOrders(
    @OrgContext() orgId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('employeeId', new ParseUUIDPipe({ optional: true })) employeeId?: string,
  ): Promise<WorkOrdersReportDto> {
    assertRequiredCalendarDateQuery(from, to);
    return this.service.workOrders(orgId, from, to, employeeId);
  }

  @Get('stock')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Залишки та рухи по складу' })
  @ApiQuery({ name: 'warehouseId', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiOkResponse({ type: StockReportDto })
  stock(
    @OrgContext() orgId: string,
    @Query('warehouseId', new ParseUUIDPipe({ optional: true })) warehouseId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<StockReportDto> {
    assertCalendarDateQuery(from, to);
    return this.service.stock(orgId, warehouseId, from, to);
  }

  @Get('profitability')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Рентабельність (виручка vs собівартість)' })
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  @ApiOkResponse({ type: ProfitabilityReportDto })
  profitability(
    @OrgContext() orgId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<ProfitabilityReportDto> {
    assertRequiredCalendarDateQuery(from, to);
    return this.service.profitability(orgId, from, to);
  }

  @Get('settlements')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Дебіторська / кредиторська заборгованість' })
  @ApiQuery({ name: 'counterpartyId', required: false })
  @ApiOkResponse({ type: SettlementsReportDto })
  settlements(
    @OrgContext() orgId: string,
    @Query('counterpartyId', new ParseUUIDPipe({ optional: true })) counterpartyId?: string,
  ): Promise<SettlementsReportDto> {
    return this.service.settlements(orgId, counterpartyId);
  }

  @Get('load')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Завантаженість підйомників' })
  @ApiQuery({ name: 'branchId', required: false })
  @ApiQuery({ name: 'from', required: true })
  @ApiQuery({ name: 'to', required: true })
  @ApiOkResponse({ type: LoadReportDto })
  load(
    @OrgContext() orgId: string,
    @Query('branchId', new ParseUUIDPipe({ optional: true })) branchId: string | undefined,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<LoadReportDto> {
    assertRequiredCalendarDateQuery(from, to);
    return this.service.load(orgId, from, to, branchId);
  }

  @Get('vat')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Звіт по ПДВ' })
  @ApiQuery({ name: 'from', required: true, example: '2026-01-01' })
  @ApiQuery({ name: 'to', required: true, example: '2026-12-31' })
  @ApiOkResponse({ type: VatReportDto })
  vat(
    @OrgContext() orgId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ): Promise<VatReportDto> {
    assertRequiredCalendarDateQuery(from, to);
    return this.service.vatReport(orgId, from, to);
  }
}
