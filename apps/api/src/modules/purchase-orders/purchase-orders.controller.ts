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
  UseInterceptors,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PurchaseOrdersService } from './purchase-orders.service';
import {
  CreatePurchaseOrderDto,
  UpdatePurchaseOrderDto,
  ReceivePurchaseOrderDto,
  TransitionPurchaseOrderDto,
  PurchaseOrderQueryDto,
  LinkedCountsDto,
} from './purchase-orders.dto';

@ApiTags('Purchase Orders')
@Controller('purchase-orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class PurchaseOrdersController {
  constructor(private readonly service: PurchaseOrdersService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Список замовлень постачальникам' })
  findAll(@OrgContext() orgId: string, @Query() query: PurchaseOrderQueryDto) {
    return this.service.findAll(
      orgId,
      query.page,
      query.limit,
      query.status,
      query.q,
      query.showDeleted === 'true',
      query.dateFrom,
      query.dateTo,
      query.sortBy,
      query.sortDir,
    );
  }

  // ─── Linked Documents ─────────────────────────────────
  // Специфічні маршрути ПЕРЕД @Get(':id') — Fastify route ordering

  @Get(':id/linked-documents')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: "Пов'язані документи замовлення (оплати, контрагент)" })
  getLinkedDocuments(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getLinkedDocuments(orgId, id);
  }

  @Post('linked-counts')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Кількість пов'язаних документів для списку замовлень (batch)" })
  getLinkedCounts(@OrgContext() orgId: string, @Body() dto: LinkedCountsDto) {
    return this.service.getLinkedCounts(orgId, dto.ids);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Замовлення постачальнику по ID' })
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @UseInterceptors(IdempotencyInterceptor) // A1: дедуплікація create під offline-retry
  @ApiOperation({ summary: 'Створити замовлення постачальнику' })
  create(@OrgContext() orgId: string, @Body() dto: CreatePurchaseOrderDto) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Оновити чернетку замовлення' })
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePurchaseOrderDto,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити чернетку замовлення' })
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }

  @Post(':id/transition')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Змінити статус замовлення (FSM)' })
  transition(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionPurchaseOrderDto,
  ) {
    return this.service.transition(orgId, id, dto.status);
  }

  @Post(':id/receive')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Прийняти товари по замовленню' })
  receive(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceivePurchaseOrderDto,
    @CurrentUser() user: { id: string },
  ) {
    // jwt.strategy.ts повертає { id, orgId, role }. Поле `sub` живе тільки у JWT payload, не в request.user.
    return this.service.receive(orgId, id, dto, user?.id);
  }

  @Post(':id/apply-pricing')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Розцінити товари замовлення за правилами ціноутворення' })
  applyPricing(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { ruleId?: string },
  ) {
    return this.service.applyPricing(orgId, id, body?.ruleId);
  }
}
