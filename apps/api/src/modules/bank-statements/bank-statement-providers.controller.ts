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
import { translateError } from '@sto/shared';
import { getLocale } from '../../common/tenant/tenant-context';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { ProviderConfigService } from '../payments/provider-config.service';
import { IntegrationLogService } from '../integration-logs/integration-log.service';
import { BankProviderRegistry } from './providers/bank-provider-registry';
import { BankStatementPullScheduler } from './bank-statement-pull.scheduler';

class UpsertBankProviderDto {
  @ApiProperty() @IsString() provider!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() apiUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  // credentials write-only: передаються лише при зміні; порожні поля не затирають наявні.
  @ApiPropertyOptional() @IsOptional() @IsObject() credentials?: Record<string, string>;
}

class ActivateBankProviderDto {
  @ApiProperty() @IsString() provider!: string;
}

class VerifyBankProviderDto {
  @ApiPropertyOptional() @IsOptional() @IsString() apiUrl?: string;
  @ApiProperty() @IsObject() credentials!: Record<string, string>;
}

@ApiTags('BankStatements')
@Controller('bank-statement-providers')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class BankStatementProvidersController {
  constructor(
    private readonly registry: BankProviderRegistry,
    private readonly providerConfig: ProviderConfigService,
    private readonly integrationLog: IntegrationLogService,
    private readonly scheduler: BankStatementPullScheduler,
  ) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Метадані банків-провайдерів виписки (code, name)' })
  list() {
    return this.registry.list();
  }

  // Verify робить зовнішній HTTP-виклик до банку — тротлимо суворіше (5/хв).
  @Post(':code/verify')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Перевірити креди банку-провайдера (без побічних ефектів)' })
  async verify(
    @OrgContext() orgId: string,
    @Param('code') code: string,
    @Body() dto: VerifyBankProviderDto,
  ) {
    if (!code || code.length > 64)
      throw new BadRequestException(
        translateError('err.deliveryProvider.invalidCode', getLocale()),
      );
    const provider = this.registry.get(code);
    if (!provider)
      throw new BadRequestException(
        translateError('err.deliveryProvider.unknown', getLocale(), { code }),
      );
    return this.integrationLog.wrap({ orgId, provider: code, operation: 'verifyCredentials' }, () =>
      provider.verifyCredentials({ apiUrl: dto.apiUrl ?? null, credentials: dto.credentials }),
    );
  }

  @Get('branch/:branchId')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Конфіги банків-провайдерів філії (без сирих кредів)' })
  branchConfigs(@OrgContext() orgId: string, @Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.providerConfig.getBranchConfigs(orgId, branchId, 'BANK');
  }

  @Patch('branch/:branchId')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Створити/оновити конфіг банку-провайдера (creds write-only)' })
  upsert(
    @OrgContext() orgId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: UpsertBankProviderDto,
  ) {
    return this.providerConfig.upsertConfig(orgId, branchId, 'BANK', dto);
  }

  @Post('branch/:branchId/activate')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Активувати банк-провайдер (ексклюзивно): інші вимикаються' })
  activate(
    @OrgContext() orgId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: ActivateBankProviderDto,
  ) {
    return this.providerConfig.activate(orgId, branchId, 'BANK', dto.provider);
  }

  @Post('pull-now')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Підтягнути виписку зараз (ставить job у чергу)' })
  pullNow(@OrgContext() orgId: string) {
    return this.scheduler.enqueueImmediate(orgId);
  }
}
