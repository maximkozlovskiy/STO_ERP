import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Param,
  ParseUUIDPipe,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean, IsObject } from 'class-validator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { PaymentGatewayRegistry } from './gateways/payment-gateway-registry';
import { IntegrationLogService } from '../integration-logs/integration-log.service';
import { ProviderConfigService } from './provider-config.service';

class UpsertGatewayDto {
  @ApiProperty() @IsString() provider!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() apiUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  // credentials write-only: передаються лише при зміні; порожні поля не затирають наявні.
  @ApiPropertyOptional() @IsOptional() @IsObject() credentials?: Record<string, string>;
}

class ActivateGatewayDto {
  @ApiProperty() @IsString() provider!: string;
}

class VerifyGatewayDto {
  @ApiPropertyOptional() @IsOptional() @IsString() apiUrl?: string;
  @ApiProperty() @IsObject() credentials!: Record<string, string>;
}

@ApiTags('Payments')
@Controller('payment-gateways')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class PaymentGatewaysController {
  constructor(
    private readonly gateways: PaymentGatewayRegistry,
    private readonly providerConfig: ProviderConfigService,
    private readonly integrationLog: IntegrationLogService,
  ) {}

  @Get()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Метадані платіжних шлюзів (code, name)' })
  list() {
    return this.gateways.list();
  }

  // Verify робить зовнішній HTTP-виклик до шлюзу — тротлимо суворіше (5/хв).
  @Post(':code/verify')
  @Roles('OWNER', 'ADMIN')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Перевірити креди платіжного шлюзу (без реального рахунку)' })
  async verify(
    @OrgContext() orgId: string,
    @Param('code') code: string,
    @Body() dto: VerifyGatewayDto,
  ) {
    if (!code || code.length > 64) throw new BadRequestException('Некоректний код шлюзу');
    const gateway = this.gateways.get(code);
    if (!gateway) throw new BadRequestException(`Невідомий платіжний шлюз: ${code}`);
    return this.integrationLog.wrap({ orgId, provider: code, operation: 'verifyCredentials' }, () =>
      gateway.verifyCredentials({ apiUrl: dto.apiUrl ?? null, credentials: dto.credentials }),
    );
  }

  @Get('branch/:branchId')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Конфіги шлюзів філії (без сирих кредів — лише hasCredentials)' })
  branchConfigs(@OrgContext() orgId: string, @Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.providerConfig.getBranchConfigs(orgId, branchId, 'PAYMENT');
  }

  @Patch('branch/:branchId')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Створити/оновити конфіг шлюзу філії (creds write-only)' })
  upsert(
    @OrgContext() orgId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: UpsertGatewayDto,
  ) {
    return this.providerConfig.upsertConfig(orgId, branchId, 'PAYMENT', dto);
  }

  @Post('branch/:branchId/activate')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Активувати шлюз (ексклюзивно): інші вимикаються' })
  activate(
    @OrgContext() orgId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: ActivateGatewayDto,
  ) {
    return this.providerConfig.activate(orgId, branchId, 'PAYMENT', dto.provider);
  }
}
