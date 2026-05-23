import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './payments.dto';

@ApiTags('Payments')
@Controller('payments')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Список платежів' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'counterpartyId', required: false })
  findAll(
    @OrgContext() orgId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('counterpartyId') counterpartyId?: string,
  ) {
    return this.service.findAll(orgId, +page, +limit, counterpartyId);
  }

  @Post()
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Зареєструвати оплату' })
  create(
    @OrgContext() orgId: string,
    @Body() dto: CreatePaymentDto,
    @CurrentUser() user: { sub: string },
  ) {
    return this.service.create(orgId, dto, user?.sub);
  }
}
