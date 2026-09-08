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
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { OrgContext } from '../../../auth/decorators/org-context.decorator';
import { ProviderConfigService } from '../../payments/provider-config.service';
import { DeliveryProviderRegistry } from './delivery-provider-registry';
import { IntegrationLogService } from '../../integration-logs/integration-log.service';

class UpsertDeliveryDto {
  @ApiProperty() @IsString() provider!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() apiUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  // credentials write-only: передаються лише при зміні; порожні поля не затирають наявні.
  @ApiPropertyOptional() @IsOptional() @IsObject() credentials?: Record<string, string>;
}

class ActivateDeliveryDto {
  @ApiProperty() @IsString() provider!: string;
}

class VerifyDeliveryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() apiUrl?: string;
  @ApiProperty() @IsObject() credentials!: Record<string, string>;
}

@ApiTags('PurchaseOrders')
@Controller('delivery-providers')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class DeliveryProvidersController {
  constructor(
    private readonly registry: DeliveryProviderRegistry,
    private readonly providerConfig: ProviderConfigService,
    private readonly integrationLog: IntegrationLogService,
  ) {}

  @Get()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Метадані служб доставки (code, name)' })
  list() {
    return this.registry.list();
  }

  // Verify робить зовнішній HTTP-виклик до служби — тротлимо суворіше (5/хв).
  @Post(':code/verify')
  @Roles('OWNER', 'ADMIN')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Перевірити API-ключ служби доставки (без побічних ефектів)' })
  async verify(
    @OrgContext() orgId: string,
    @Param('code') code: string,
    @Body() dto: VerifyDeliveryDto,
  ) {
    if (!code || code.length > 64) throw new BadRequestException('Некоректний код служби');
    const provider = this.registry.get(code);
    if (!provider) throw new BadRequestException(`Невідома служба доставки: ${code}`);
    return this.integrationLog.wrap({ orgId, provider: code, operation: 'verifyCredentials' }, () =>
      provider.verifyCredentials({ apiUrl: dto.apiUrl ?? null, credentials: dto.credentials }),
    );
  }

  @Get('branch/:branchId')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Конфіги служб доставки філії (без сирих кредів)' })
  branchConfigs(@OrgContext() orgId: string, @Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.providerConfig.getBranchConfigs(orgId, branchId, 'DELIVERY');
  }

  @Patch('branch/:branchId')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Створити/оновити конфіг служби доставки (creds write-only)' })
  upsert(
    @OrgContext() orgId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: UpsertDeliveryDto,
  ) {
    return this.providerConfig.upsertConfig(orgId, branchId, 'DELIVERY', dto);
  }

  @Post('branch/:branchId/activate')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Активувати службу доставки (ексклюзивно): інші вимикаються' })
  activate(
    @OrgContext() orgId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: ActivateDeliveryDto,
  ) {
    return this.providerConfig.activate(orgId, branchId, 'DELIVERY', dto.provider);
  }
}
