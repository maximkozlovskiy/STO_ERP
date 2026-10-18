import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { OrgContext } from '../../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../auth/strategies/jwt.strategy';
import { IdempotencyInterceptor } from '../../../common/interceptors/idempotency.interceptor';
import { SupplierOrdersService } from './supplier-orders.service';
import { PurchaseOrderSupplierApiDto, SupplierApiReleaseResultDto } from './supplier-orders.dto';

/** Дії з передачею в API — ті, хто веде закупівлю; перегляд — ще й бухгалтер (план). */
const SEND_ROLES = ['OWNER', 'ADMIN', 'STOREKEEPER'] as const;
const READ_ROLES = ['OWNER', 'ADMIN', 'STOREKEEPER', 'ACCOUNTANT'] as const;

@ApiTags('Supplier API')
@Controller('purchase-orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class SupplierOrdersController {
  constructor(private readonly service: SupplierOrdersService) {}

  @Get(':id/supplier-api')
  @Roles(...READ_ROLES)
  @ApiOperation({ summary: 'Передача замовлення постачальнику через API: стан (BR-PO-011)' })
  @ApiOkResponse({ type: PurchaseOrderSupplierApiDto })
  state(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.getState(orgId, id, user.role);
  }

  @Post(':id/supplier-api/send')
  @Roles(...SEND_ROLES)
  @HttpCode(HttpStatus.ACCEPTED)
  // Повтор із тим самим ключем (обрив зв'язку з браузером) не ставить другу відправку.
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({
    summary: 'Відправити замовлення в API постачальника — через чергу (BR-SCON-009)',
  })
  @ApiOkResponse({ type: PurchaseOrderSupplierApiDto })
  send(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.send(orgId, id, user.role);
  }

  @Post(':id/supplier-api/poll')
  @Roles(...SEND_ROLES)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Оновити статус у постачальника — через чергу (BR-SCON-012)' })
  @ApiOkResponse({ type: PurchaseOrderSupplierApiDto })
  poll(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.requestPoll(orgId, id, user.role);
  }

  @Post(':id/supplier-api/release-unconfirmed')
  @Roles(...SEND_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Повернути непідтверджене постачальником у список купівлі (BR-SCON-013)',
  })
  @ApiOkResponse({ type: SupplierApiReleaseResultDto })
  release(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.releaseUnconfirmed(orgId, id, user.role);
  }
}
