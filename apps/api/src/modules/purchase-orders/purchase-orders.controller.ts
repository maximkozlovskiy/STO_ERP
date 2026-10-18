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
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiBearerAuth,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
} from '@nestjs/swagger';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PurchaseOrdersService } from './purchase-orders.service';
import { LinesSummaryService } from '../lines-summary/lines-summary.service';
import { LinesSummaryDto } from '../lines-summary/lines-summary.dto';
import {
  purchaseOrderCreateSchema,
  purchaseOrderUpdateSchema,
  type PurchaseOrderCreateValues,
  type PurchaseOrderUpdateValues,
} from '@sto/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  WithDeletedQueryPipe,
  WITH_DELETED_API_QUERY,
  type WithDeletedOption,
} from '../../common/pipes/with-deleted-query.pipe';
import {
  ReceivePurchaseOrderDto,
  TransitionPurchaseOrderDto,
  PurchaseOrderQueryDto,
  LinkedCountsDto,
  PurchaseOrderResponseDto,
  PaginatedPurchaseOrdersDto,
  ApplyPricingDto,
  ApplyPricingResponseDto,
} from './purchase-orders.dto';

@ApiTags('Purchase Orders')
@Controller('purchase-orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class PurchaseOrdersController {
  constructor(
    private readonly service: PurchaseOrdersService,
    private readonly linesSummary: LinesSummaryService,
  ) {}

  @Get()
  // ACCOUNTANT: пікер замовлення в модалці рознесення банківського платежу (BR-BANK-027).
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Список замовлень постачальникам' })
  @ApiOkResponse({ type: PaginatedPurchaseOrdersDto })
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
      query.supplierId,
    );
  }

  // ─── Linked Documents ─────────────────────────────────
  // Специфічні маршрути ПЕРЕД @Get(':id') — Fastify route ordering

  // BR-WO-009: ролі — як у СПИСКУ (панель списку показує зведення кожному, хто бачить список).
  @Get(':id/lines-summary')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Зведення по табличних частинах замовлення постачальнику' })
  @ApiOkResponse({ type: LinesSummaryDto })
  getLinesSummary(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LinesSummaryDto> {
    return this.linesSummary.forPurchaseOrder(orgId, id);
  }

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
  @ApiOkResponse({ type: PurchaseOrderResponseDto })
  @ApiQuery(WITH_DELETED_API_QUERY)
  findOne(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('withDeleted', WithDeletedQueryPipe) opts: WithDeletedOption,
  ) {
    // BR-WO-012: прапорець приймає лише цей маршрут — решта викликів findOne бачить невидалені.
    return this.service.findOne(orgId, id, opts);
  }

  @Post()
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @UseInterceptors(IdempotencyInterceptor) // A1: дедуплікація create під offline-retry
  @ApiOperation({ summary: 'Створити замовлення постачальнику' })
  @ApiCreatedResponse({ type: PurchaseOrderResponseDto })
  create(
    @OrgContext() orgId: string,
    @Body(new ZodValidationPipe(purchaseOrderCreateSchema)) dto: PurchaseOrderCreateValues,
  ) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Оновити чернетку замовлення' })
  @ApiOkResponse({ type: PurchaseOrderResponseDto })
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(purchaseOrderUpdateSchema)) dto: PurchaseOrderUpdateValues,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити чернетку замовлення' })
  @ApiNoContentResponse()
  @ApiQuery({
    name: 'force',
    required: false,
    description: 'Видалити, хоч замовлення вже передане постачальнику через API (BR-PO-012)',
  })
  remove(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('force') force?: string,
  ) {
    return this.service.remove(orgId, id, force === 'true');
  }

  @Post(':id/transition')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Змінити статус замовлення (FSM)' })
  @ApiOkResponse({ type: PurchaseOrderResponseDto })
  transition(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionPurchaseOrderDto,
  ) {
    return this.service.transition(orgId, id, dto.status, { force: dto.force === true });
  }

  @Post(':id/receive')
  @Roles('OWNER', 'ADMIN', 'STOREKEEPER')
  @ApiOperation({ summary: 'Прийняти товари по замовленню' })
  @ApiOkResponse({ type: PurchaseOrderResponseDto })
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
  @ApiOkResponse({ type: ApplyPricingResponseDto })
  applyPricing(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ApplyPricingDto,
  ) {
    return this.service.applyPricing(orgId, id, body?.ruleId);
  }
}
