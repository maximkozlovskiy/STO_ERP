import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';
import { LoyaltyService } from './loyalty.service';
import { RedeemLoyaltyDto } from './loyalty.dto';

@ApiTags('loyalty')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('loyalty')
export class LoyaltyController {
  constructor(private readonly service: LoyaltyService) {}

  @Get('balance/:counterpartyId')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Баланс балів лояльності контрагента' })
  getBalance(
    @Param('counterpartyId', ParseUUIDPipe) counterpartyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.getBalance(user.orgId, counterpartyId);
  }

  @Get('transactions/:counterpartyId')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Транзакції балів лояльності' })
  getTransactions(
    @Param('counterpartyId', ParseUUIDPipe) counterpartyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.getTransactions(user.orgId, counterpartyId);
  }

  @Post('redeem/:counterpartyId')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Списати бали лояльності' })
  redeem(
    @Param('counterpartyId', ParseUUIDPipe) counterpartyId: string,
    @Body() dto: RedeemLoyaltyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.redeem(user.orgId, counterpartyId, dto.points);
  }
}
