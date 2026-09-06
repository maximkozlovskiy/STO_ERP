import { Body, Controller, Get, Param, Post, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
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

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST')
  @ApiOperation({ summary: 'Статус наміру оплати (frontend polling)' })
  get(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.getIntent(orgId, id);
  }
}
