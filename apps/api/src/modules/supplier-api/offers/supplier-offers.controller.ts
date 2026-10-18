import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  supplierOfferAllocateSchema,
  supplierOfferChooseSchema,
  supplierOfferSearchSchema,
  type SupplierOfferAllocateValues,
  type SupplierOfferChooseValues,
  type SupplierOfferSearchValues,
} from '@sto/shared';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { OrgContext } from '../../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../auth/strategies/jwt.strategy';
import { PurchaseListItemResponseDto } from '../../purchase-lists/purchase-lists.dto';
import { SupplierOffersService } from './supplier-offers.service';
import { SupplierAllocationService } from '../strategy/supplier-allocation.service';
import {
  SupplierAllocationResultDto,
  SupplierOfferBatchDto,
  SupplierOfferItemDto,
  SupplierOfferSearchResultDto,
  SupplierProcurementSettingsDto,
} from './supplier-offers.dto';

/** Пропозиції, вибір, автопідбір — ті, хто веде закупівлю (план, BR-SOFR-002). */
export const SOFR_ROLES = ['OWNER', 'ADMIN', 'STOREKEEPER'] as const;

@ApiTags('Supplier API')
@Controller('supplier-offers')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class SupplierOffersController {
  constructor(
    private readonly service: SupplierOffersService,
    private readonly allocation: SupplierAllocationService,
  ) {}

  @Post('search')
  @Roles(...SOFR_ROLES)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Пошук пропозицій для позицій — через чергу (BR-SOFR-002)' })
  @ApiOkResponse({ type: SupplierOfferSearchResultDto })
  search(
    @OrgContext() orgId: string,
    @Body(new ZodValidationPipe(supplierOfferSearchSchema)) dto: SupplierOfferSearchValues,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.search(orgId, dto, { userId: user.id, role: user.role });
  }

  @Post('allocate')
  @Roles(...SOFR_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Автопідбір за стратегією: перегляд (dryRun) або застосування (BR-SOFR-009)',
  })
  @ApiOkResponse({ type: SupplierAllocationResultDto })
  allocate(
    @OrgContext() orgId: string,
    @Body(new ZodValidationPipe(supplierOfferAllocateSchema)) dto: SupplierOfferAllocateValues,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.allocation.allocate(orgId, dto, user.role);
  }

  @Get('settings')
  @Roles(...SOFR_ROLES)
  @ApiOperation({
    summary: 'Налаштування закупівлі через API для діалогів: стратегія за замовчуванням, TTL',
  })
  @ApiOkResponse({ type: SupplierProcurementSettingsDto })
  procurementSettings(@OrgContext() orgId: string) {
    return this.service.procurementSettings(orgId);
  }

  @Get('batches/:id')
  @Roles(...SOFR_ROLES)
  @ApiOperation({ summary: 'Стан пошуку пропозицій: підключення й пропозиції (UI опитує)' })
  @ApiOkResponse({ type: SupplierOfferBatchDto })
  batch(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.getBatch(orgId, id, user.role);
  }
}

@ApiTags('Supplier API')
@Controller('purchase-list-items')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class SupplierItemOffersController {
  constructor(private readonly service: SupplierOffersService) {}

  @Get(':id/offers')
  @Roles(...SOFR_ROLES)
  @ApiOperation({ summary: 'Останні відомі пропозиції позиції — без мережі (BR-SOFR-003)' })
  @ApiOkResponse({ type: SupplierOfferItemDto })
  offers(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.itemOffers(orgId, id, user.role);
  }

  @Post(':id/choose-offer')
  @Roles(...SOFR_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Обрати пропозицію: постачальник, ціна в гривні, знімок (BR-SOFR-006)' })
  @ApiOkResponse({ type: PurchaseListItemResponseDto })
  choose(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(supplierOfferChooseSchema)) dto: SupplierOfferChooseValues,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.chooseOffer(orgId, id, dto.offerId, user.role);
  }

  @Delete(':id/offer')
  @Roles(...SOFR_ROLES)
  @ApiOperation({ summary: 'Зняти обрану пропозицію (постачальник і ціна лишаються)' })
  @ApiOkResponse({ type: PurchaseListItemResponseDto })
  clear(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.clearOffer(orgId, id, user.role);
  }
}
