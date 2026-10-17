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
  purchaseListCreateSchema,
  purchaseListFromWorkOrderSchema,
  purchaseListManualItemSchema,
  purchaseListMergeSchema,
  purchaseListUpdateSchema,
  type PurchaseListCreateValues,
  type PurchaseListFromWorkOrderValues,
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
import { LinkedCountsDto } from '../purchase-orders/purchase-orders.dto';
import { PurchaseListsService } from './purchase-lists.service';
import { PL_READ_ROLES, PL_WRITE_ROLES } from './purchase-lists.helpers';
import {
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
  constructor(private readonly service: PurchaseListsService) {}

  @Get()
  @Roles(...PL_READ_ROLES)
  @ApiOperation({ summary: 'Списки купівлі' })
  @ApiOkResponse({ type: PaginatedPurchaseListsDto })
  findAll(@OrgContext() orgId: string, @Query() query: PurchaseListQueryDto) {
    return this.service.findAll(orgId, query);
  }

  // Специфічні маршрути ПЕРЕД :id — Fastify route ordering.

  @Post('linked-counts')
  @Roles(...PL_READ_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Кількість пов'язаних документів для списків (batch)" })
  getLinkedCounts(@OrgContext() orgId: string, @Body() dto: LinkedCountsDto) {
    return this.service.getLinkedCounts(orgId, dto.ids);
  }

  @Post('from-work-order')
  @Roles(...PL_READ_ROLES)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'Товари наряду → до списку купівлі (BR-PL-003)' })
  @ApiCreatedResponse({ type: FromWorkOrderResultDto })
  fromWorkOrder(
    @OrgContext() orgId: string,
    @Body(new ZodValidationPipe(purchaseListFromWorkOrderSchema))
    dto: PurchaseListFromWorkOrderValues,
  ) {
    return this.service.fromWorkOrder(orgId, dto);
  }

  @Post('merge')
  @Roles(...PL_WRITE_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Об'єднати списки (BR-PL-006)" })
  @ApiOkResponse({ type: PurchaseListDetailDto })
  merge(
    @OrgContext() orgId: string,
    @Body(new ZodValidationPipe(purchaseListMergeSchema)) dto: PurchaseListMergeValues,
  ) {
    return this.service.merge(orgId, dto);
  }

  @Post()
  @Roles(...PL_READ_ROLES)
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
  @Roles(...PL_READ_ROLES)
  @ApiOperation({ summary: "Пов'язані документи списку (наряди, замовлення, злиті списки)" })
  getLinkedDocuments(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getLinkedDocuments(orgId, id);
  }

  @Post(':id/items')
  @Roles(...PL_WRITE_ROLES)
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
  @Roles(...PL_WRITE_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Закрити список' })
  @ApiOkResponse({ type: PurchaseListResponseDto })
  close(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.close(orgId, id);
  }

  @Post(':id/cancel')
  @Roles(...PL_WRITE_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Скасувати список (без замовлених позицій)' })
  @ApiOkResponse({ type: PurchaseListResponseDto })
  cancel(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.cancel(orgId, id);
  }

  @Get(':id')
  @Roles(...PL_READ_ROLES)
  @ApiOperation({ summary: 'Список купівлі з позиціями' })
  @ApiOkResponse({ type: PurchaseListDetailDto })
  findOne(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(orgId, id);
  }

  @Patch(':id')
  @Roles(...PL_WRITE_ROLES)
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
  @Roles(...PL_WRITE_ROLES)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Видалити список (без замовлених позицій)' })
  @ApiNoContentResponse()
  remove(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(orgId, id);
  }
}
