import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  purchaseListItemIdsSchema,
  purchaseListItemSplitSchema,
  purchaseListItemsBulkUpdateSchema,
  purchaseListItemsMoveSchema,
  purchaseListItemUpdateSchema,
  type PurchaseListItemIdsValues,
  type PurchaseListItemSplitValues,
  type PurchaseListItemsBulkUpdateValues,
  type PurchaseListItemsMoveValues,
  type PurchaseListItemUpdateValues,
} from '@sto/shared';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { PurchaseListItemsService } from './purchase-list-items.service';
import { PurchaseShortageService } from './purchase-shortage.service';
import { PL_READ_ROLES, PL_WRITE_ROLES } from './purchase-lists.helpers';
import {
  BulkResultDto,
  PaginatedPurchaseListItemsDto,
  PurchaseListItemQueryDto,
  PurchaseListItemResponseDto,
  ReleaseReservationResultDto,
  ShortageQueryDto,
  ShortageResponseDto,
  WorkOrderProcurementDto,
} from './purchase-lists.dto';

/** Позиції списків купівлі й нестача по нарядах. Ролі — BR-PL-015. */
@ApiTags('Purchase Lists')
@Controller('purchase-list-items')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class PurchaseListItemsController {
  constructor(
    private readonly service: PurchaseListItemsService,
    private readonly shortage: PurchaseShortageService,
  ) {}

  @Get('shortage')
  @Roles(...PL_READ_ROLES)
  @ApiOperation({ summary: 'Нестача товарів по нарядах (BR-PL-014)' })
  @ApiOkResponse({ type: ShortageResponseDto })
  getShortage(@OrgContext() orgId: string, @Query() query: ShortageQueryDto) {
    return this.shortage.shortage(orgId, query);
  }

  @Get('by-work-order/:workOrderId')
  // MECHANIC бачить стан товарів у картці наряду (BR-PL-015).
  @Roles(...PL_READ_ROLES, 'MECHANIC')
  @ApiOperation({ summary: 'Позиції списків купівлі наряду й нестача його рядків' })
  @ApiOkResponse({ type: WorkOrderProcurementDto })
  byWorkOrder(
    @OrgContext() orgId: string,
    @Param('workOrderId', ParseUUIDPipe) workOrderId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // §2.1: механік і приймальня не бачать очікуваної (закупівельної) ціни — maskItemCost.
    return this.service.byWorkOrder(orgId, workOrderId, user.role);
  }

  @Get()
  @Roles(...PL_READ_ROLES)
  @ApiOperation({ summary: 'Позиції списків купівлі' })
  @ApiOkResponse({ type: PaginatedPurchaseListItemsDto })
  findAll(
    @OrgContext() orgId: string,
    @Query() query: PurchaseListItemQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.findAll(orgId, query, user.role);
  }

  @Post('move')
  @Roles(...PL_WRITE_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Перенести позиції в інший список (BR-PL-007)' })
  @ApiOkResponse({ type: BulkResultDto })
  move(
    @OrgContext() orgId: string,
    @Body(new ZodValidationPipe(purchaseListItemsMoveSchema)) dto: PurchaseListItemsMoveValues,
  ) {
    return this.service.move(orgId, dto);
  }

  @Post('bulk-update')
  @Roles(...PL_WRITE_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Масово: постачальник і очікувана ціна' })
  @ApiOkResponse({ type: BulkResultDto })
  bulkUpdate(
    @OrgContext() orgId: string,
    @Body(new ZodValidationPipe(purchaseListItemsBulkUpdateSchema))
    dto: PurchaseListItemsBulkUpdateValues,
  ) {
    return this.service.bulkUpdate(orgId, dto);
  }

  @Post('bulk-cancel')
  @Roles(...PL_WRITE_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Масово скасувати позиції' })
  @ApiOkResponse({ type: BulkResultDto })
  bulkCancel(
    @OrgContext() orgId: string,
    @Body(new ZodValidationPipe(purchaseListItemIdsSchema)) dto: PurchaseListItemIdsValues,
  ) {
    return this.service.bulkCancel(orgId, dto);
  }

  @Post(':id/split')
  @Roles(...PL_WRITE_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Розділити позицію (BR-PL-007)' })
  @ApiOkResponse({ type: [PurchaseListItemResponseDto] })
  split(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(purchaseListItemSplitSchema)) dto: PurchaseListItemSplitValues,
  ) {
    return this.service.split(orgId, id, dto);
  }

  @Post(':id/release-reservation')
  @Roles(...PL_WRITE_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Зняти резерв отриманого з позиції (BR-PL-016)' })
  @ApiOkResponse({ type: ReleaseReservationResultDto })
  releaseReservation(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.releaseReservation(orgId, id, user.id);
  }

  @Patch(':id')
  @Roles(...PL_WRITE_ROLES)
  @ApiOperation({ summary: 'Змінити позицію (лише OPEN, BR-PL-005)' })
  @ApiOkResponse({ type: PurchaseListItemResponseDto })
  update(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(purchaseListItemUpdateSchema)) dto: PurchaseListItemUpdateValues,
  ) {
    return this.service.update(orgId, id, dto);
  }
}
