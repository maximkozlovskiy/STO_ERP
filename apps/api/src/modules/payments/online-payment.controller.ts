import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsUUID, IsOptional, IsNumber, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { OnlinePaymentService } from './online-payment.service';

class CreateIntentDto {
  @ApiProperty() @IsUUID() invoiceId!: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0.01) amount?: number;
}

class ActiveGatewayQueryDto {
  @ApiProperty() @IsUUID() invoiceId!: string;
}

class ActiveGatewayDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Код шлюзу (monobank, liqpay) або null',
  })
  provider!: string | null;
}

@ApiTags('Online Payments')
@Controller('online-payments')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class OnlinePaymentController {
  constructor(private readonly service: OnlinePaymentService) {}

  // Створення наміру = зовнішній gateway-виклик — тротлимо.
  @Post()
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Створити QR-намір оплати (monobank)' })
  create(@OrgContext() orgId: string, @Body() dto: CreateIntentDto) {
    return this.service.createIntent(orgId, dto);
  }

  // Специфічний маршрут — ПЕРЕД `:id` (Fastify матчить у порядку оголошення).
  @Get('gateway')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({
    summary: 'Підключений платіжний шлюз для QR-оплати рахунку (BR-PAY-033): провайдер або null',
  })
  @ApiOkResponse({ type: ActiveGatewayDto })
  gateway(@OrgContext() orgId: string, @Query() query: ActiveGatewayQueryDto) {
    return this.service.activeGatewayForInvoice(orgId, query.invoiceId);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Статус наміру оплати (frontend polling)' })
  get(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getIntent(orgId, id);
  }
}
