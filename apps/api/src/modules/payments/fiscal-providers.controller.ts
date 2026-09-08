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
import { IsString, IsOptional, IsBoolean, IsObject, IsIn } from 'class-validator';
import { ShiftMode } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import { FiscalProviderRegistry } from './fiscal/fiscal-provider-registry';
import { IntegrationLogService } from '../integration-logs/integration-log.service';
import { ProviderConfigService } from './provider-config.service';

class UpsertFiscalDto {
  @ApiProperty() @IsString() provider!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() apiUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional({ enum: ShiftMode })
  @IsOptional()
  @IsIn(Object.values(ShiftMode))
  shiftMode?: ShiftMode;
  // credentials write-only: передаються лише при зміні; порожні поля не затирають наявні.
  @ApiPropertyOptional() @IsOptional() @IsObject() credentials?: Record<string, string>;
}

class ActivateFiscalDto {
  @ApiProperty() @IsString() provider!: string;
}

class VerifyFiscalDto {
  @ApiPropertyOptional() @IsOptional() @IsString() apiUrl?: string;
  @ApiProperty() @IsObject() credentials!: Record<string, string>;
}

@ApiTags('Payments')
@Controller('fiscal-providers')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class FiscalProvidersController {
  constructor(
    private readonly registry: FiscalProviderRegistry,
    private readonly providerConfig: ProviderConfigService,
    private readonly integrationLog: IntegrationLogService,
  ) {}

  @Get()
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Метадані провайдерів ПРРО (code, name)' })
  list() {
    return this.registry.list();
  }

  // Verify робить зовнішній HTTP-виклик до провайдера — тротлимо суворіше (5/хв).
  @Post(':code/verify')
  @Roles('OWNER', 'ADMIN')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Перевірити креди провайдера ПРРО (без пробиття чеку)' })
  async verify(
    @OrgContext() orgId: string,
    @Param('code') code: string,
    @Body() dto: VerifyFiscalDto,
  ) {
    if (!code || code.length > 64) throw new BadRequestException('Некоректний код провайдера');
    const provider = this.registry.get(code);
    if (!provider) throw new BadRequestException(`Невідомий провайдер ПРРО: ${code}`);
    return this.integrationLog.wrap({ orgId, provider: code, operation: 'verifyCredentials' }, () =>
      provider.verifyCredentials({ apiUrl: dto.apiUrl ?? null, credentials: dto.credentials }),
    );
  }

  @Get('branch/:branchId')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Конфіги провайдерів ПРРО філії (без сирих кредів)' })
  branchConfigs(@OrgContext() orgId: string, @Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.providerConfig.getBranchConfigs(orgId, branchId, 'FISCAL');
  }

  @Patch('branch/:branchId')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Створити/оновити конфіг провайдера ПРРО (creds write-only)' })
  upsert(
    @OrgContext() orgId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: UpsertFiscalDto,
  ) {
    return this.providerConfig.upsertConfig(orgId, branchId, 'FISCAL', dto);
  }

  @Post('branch/:branchId/activate')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Активувати провайдера ПРРО (ексклюзивно): інші вимикаються' })
  activate(
    @OrgContext() orgId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: ActivateFiscalDto,
  ) {
    return this.providerConfig.activate(orgId, branchId, 'FISCAL', dto.provider);
  }
}
