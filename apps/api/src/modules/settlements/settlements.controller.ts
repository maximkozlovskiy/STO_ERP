import { Controller, Get, Post, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { SettlementsAccountService } from './settlements-account.service';
import { CreateReconciliationActDto } from './settlements.dto';

@ApiTags('Settlements')
@Controller('counterparties/:counterpartyId')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class SettlementsController {
  constructor(private readonly service: SettlementsAccountService) {}

  @Get('balance')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Р‘Р°Р»Р°РЅСЃ РєРѕРЅС‚СЂР°РіРµРЅС‚Р°' })
  getBalance(@OrgContext() orgId: string, @Param('counterpartyId') counterpartyId: string) {
    return this.service.getBalance(orgId, counterpartyId);
  }

  @Get('transactions')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'РўСЂР°РЅР·Р°РєС†С–С— РєРѕРЅС‚СЂР°РіРµРЅС‚Р°' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getTransactions(
    @OrgContext() orgId: string,
    @Param('counterpartyId') counterpartyId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
  ) {
    return this.service.getTransactions(orgId, counterpartyId, +page, +limit);
  }

  @Post('reconciliation-acts')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'РЎС‚РІРѕСЂРёС‚Рё Р°РєС‚ Р·РІС–СЂРєРё' })
  createAct(
    @OrgContext() orgId: string,
    @Param('counterpartyId') counterpartyId: string,
    @Body() dto: CreateReconciliationActDto,
    @CurrentUser() user: { sub: string },
  ) {
    return this.service.createReconciliationAct(orgId, counterpartyId, dto, user?.sub);
  }

  @Get('reconciliation-acts')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'РђРєС‚Рё Р·РІС–СЂРєРё РєРѕРЅС‚СЂР°РіРµРЅС‚Р°' })
  getActs(@OrgContext() orgId: string, @Param('counterpartyId') counterpartyId: string) {
    return this.service.getReconciliationActs(orgId, counterpartyId);
  }
}
