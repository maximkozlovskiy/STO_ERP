import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  PROCUREMENT_READ_ROLES,
  PROCUREMENT_WRITE_ROLES,
  purchaseListCreateSchema,
  purchaseListFromWorkOrderSchema,
  purchaseListItemIdsSchema,
  purchaseListManualItemSchema,
  purchaseListMergeSchema,
  purchaseListUpdateSchema,
  type PurchaseListCreateValues,
  type PurchaseListFromWorkOrderValues,
  type PurchaseListItemIdsValues,
  type PurchaseListManualItemValues,
  type PurchaseListMergeValues,
  type PurchaseListUpdateValues,
} from '@sto/shared';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { LinkedCountsDto } from '../purchase-orders/purchase-orders.dto';
import { PurchaseListsService } from './purchase-lists.service';
import { PurchaseListOrdersService } from './purchase-list-orders.service';
import {
  CreateOrdersResultDto,
  FromWorkOrderResultDto,
  PaginatedPurchaseListsDto,
  PurchaseListDetailDto,
  PurchaseListItemResponseDto,
  PurchaseListQueryDto,
  PurchaseListResponseDto,
} from './purchase-lists.dto';

/** Списки купівлі (docs/objects/purchase-list.md). Ролі — BR-PL-015. */
@ApiTags('Purchase Lists')
@Controller('purchase-lists')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class PurchaseListsController {
  constructor(
    private readonly service: PurchaseListsService,
    private readonly orders: PurchaseListOrdersService,
  ) {}

  @Get()
  @Roles(...PROCUREMENT_READ_ROLES)
  @ApiOperation({ summary: 'Списки купівлі' })
  @ApiOkResponse({ type: PaginatedPurchaseListsDto })
  findAll(@OrgContext() orgId: string, @Query() query: PurchaseListQueryDto) {
    return this.service.findAll(orgId, query);
  }

  // Специфічні маршрути ПЕРЕД :id — Fastify route ordering.

  @Post('linked-counts')
  @Roles(...PROCUREMENT_READ_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Кількість пов'язаних документів для списків (batch)" })
  getLinkedCounts(@OrgContext() orgId: string, @Body() dto: LinkedCountsDto) {
    return this.service.getLinkedCounts(orgId, dto.ids);
  }

  @Post('from-work-order')
  @Roles(...PROCUREMENT_READ_ROLES)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'Товари наряду → до списку купівлі (BR-PL-003)' })
  @ApiCreatedResponse({ type: FromWorkOrderResultDto })
  fromWorkOrder(
    @OrgContext() orgId: string,
    @Body(new ZodValidationPipe(purchaseListFromWorkOrderSchema))
    dto: PurchaseListFromWorkOrderValues,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // §2.1: очікувану ціну позицій бачать лише ролі із закупівельною ціною (maskItemCost).
    return this.service.fromWorkOrder(orgId, dto, user.role);
  }

  @Post('merge')
  @Roles(...PROCUREMENT_WRITE_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Об'єднати списки (BR-PL-006)" })
  @ApiOkResponse({ type: PurchaseListDetailDto })
  merge(
    @OrgContext() orgId: string,
    @Body(new ZodValidationPipe(purchaseListMergeSchema)) dto: PurchaseListMergeValues,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.merge(orgId, dto, user.role);
  }

  @Post('create-orders')
  @Roles(...PROCUREMENT_WRITE_ROLES)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'Створити замовлення постачальникам з позицій (BR-PL-008)' })
  @ApiCreatedResponse({ type: CreateOrdersResultDto })
  createOrders(
    @OrgContext() orgId: string,
    @Body(new ZodValidationPipe(purchaseListItemIdsSchema)) dto: PurchaseListItemIdsValues,
  ) {
    return this.orders.createOrders(orgId, dto.itemIds);
  }

  @Post()
  @Roles(...PROCUREMENT_READ_ROLES)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'Створити список купівлі' })
  @ApiCreatedResponse({ type: PurchaseListResponseDto })
  create(
    @OrgContext() orgId: string,
    @Body(new ZodValidationPipe(purchaseListCreateSchema)) dto: PurchaseListCreateValues,
  ) {
    return this.service.create(orgId, dto);
  }

  @Get(':id/linked-documents')
  @Roles(...PROCUREMENT_READ_ROLES)
  @ApiOperation({ summary: "Пов'язані документи списку (наряди, замовлення, злиті списки)" })
  getLinkedDocuments(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getLinkedDocuments(orgId, id);
  }

  @Post(':id/items')
  @Roles(...PROCUREMENT_WRITE_ROLES)
  @ApiOperation({ summary: 'Ручна позиція (BR-PL-004)' })
  @ApiCreatedResponse({ type: PurchaseListItemResponseDto })
  addItem(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(purchaseListManualItemSchema)) dto: PurchaseListManualItemValues,
  ) {
    return this.service.addItem(orgId, id, dto);
  }

  @Post(':id/close')
  @Roles(...PROCUREMENT_WRITE_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Закрити список' })
  @ApiOkResponse({ type: PurchaseListResponseDto })
  close(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.close(orgId, id);
  }

  @Post(':id/cancel')
  @Roles(...PROCUREMENT_WRITE_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Скасувати список (без замовлених позицій)' })
  @ApiOkResponse({ type: PurchaseListResponseDto })
  cancel(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.cancel(orgId, id);
  }

  @Get(':id')
  @Roles(...PROCUREMENT_READ_ROLES)
  @ApiOperation({ summary: 'Список купівлі з позиціями' })
  @ApiOkResponse({ type: PurchaseListDetailDto })
  findOne(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.findOne(orgId, id, user.role);
  }

  @Patch(':id')
  @Roles(...PROCUREMENT_WRITE_ROLES)
  @ApiOperation({ summary: 'Змінити список (назва, склад, примітка)' })
  @ApiOkResponse({ type: PurchaseListResponseDto })
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(purchaseListUpdateSchema)) dto: PurchaseListUpdateValues,
  ) {
    return this.service.update(orgId, id, dto);
  }

  @Delete(':id')
  @Roles(...PROCUREMENT_WRITE_ROLES)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити список (без замовлених позицій)' })
  @ApiNoContentResponse()
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }
}
