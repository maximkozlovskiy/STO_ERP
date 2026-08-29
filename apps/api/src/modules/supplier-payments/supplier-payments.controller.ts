import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { SupplierPaymentsService } from './supplier-payments.service';
import {
  CreateSupplierPaymentDto,
  UpdateSupplierPaymentDto,
  SupplierPaymentQueryDto,
  SupplierPaymentScheduleQueryDto,
} from './supplier-payments.dto';

@ApiTags('Supplier Payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('supplier-payments')
export class SupplierPaymentsController {
  constructor(private readonly service: SupplierPaymentsService) {}

  @Post()
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Створити оплату постачальнику (чернетка)' })
  create(
    @OrgContext() orgId: string,
    @Body() dto: CreateSupplierPaymentDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.create(orgId, dto, user.id);
  }

  @Get()
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Список оплат постачальникам' })
  findAll(@OrgContext() orgId: string, @Query() query: SupplierPaymentQueryDto) {
    return this.service.findAll(
      orgId,
      query.page ? parseInt(query.page, 10) : 1,
      query.limit ? parseInt(query.limit, 10) : 20,
      query.status,
      query.supplierId,
      query.q,
      query.showDeleted === 'true',
      query.dateFrom,
      query.dateTo,
      query.sortBy,
      query.sortDir,
      query.purchaseOrderId,
    );
  }

  // Specific sub-routes BEFORE :id (Fastify route ordering rule)
  @Get('schedule')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Графік оплат постачальникам (шахматка по датах)' })
  getSchedule(@OrgContext() orgId: string, @Query() query: SupplierPaymentScheduleQueryDto) {
    return this.service.getSchedule(orgId, query.from, query.to);
  }

  @Post(':id/confirm')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Провести оплату (settlement PAYMENT)' })
  confirm(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.confirm(orgId, id, user.id);
  }

  @Post(':id/cancel')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Скасувати оплату' })
  cancel(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.cancel(orgId, id);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Деталі оплати постачальнику' })
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Оновити оплату (тільки DRAFT)' })
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupplierPaymentDto,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити оплату (soft delete, крім проведеної)' })
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }
}
