import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { ResetPeriod } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { OrgContext } from '../../auth/decorators/org-context.decorator';
import {
  BranchSettingsResponseDto,
  OrganisationSettingsResponseDto,
  UiFeatures,
  UpdateBranchSettingsDto,
  UpdateOrganisationSettingsDto,
} from './settings.dto';
import { SettingsService } from './settings.service';

class UpdateDocNumberDto {
  @ApiPropertyOptional() @IsOptional() @IsString() prefix?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() includeDate?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() separator?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(10) padding?: number;
  @ApiPropertyOptional({ enum: ResetPeriod })
  @IsOptional()
  @IsIn(Object.values(ResetPeriod))
  resetPeriod?: ResetPeriod;
}

class CreateTaxRateDto {
  @ApiProperty() @IsString() name!: string;
  @ApiProperty() @IsNumber() @Min(0) @Max(100) rate!: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

class UpdateTaxRateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Max(100) rate?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

@ApiTags('Налаштування')
@Controller('settings')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class SettingsController {
  constructor(private readonly service: SettingsService) {}

  @Get('organisation')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Налаштування організації' })
  @ApiResponse({ status: 200, type: OrganisationSettingsResponseDto })
  getOrganisation(@OrgContext() orgId: string) {
    return this.service.getOrganisationSettings(orgId);
  }

  // UI feature flags must be readable by ALL authenticated roles
  // (work-orders page is shown to RECEPTIONIST/MECHANIC/ACCOUNTANT and
  // every such page mounts useUiFeatures). Restricting to OWNER/ADMIN
  // would force a 403 on every navigation for non-admin staff.
  @Get('ui-features')
  @Roles('OWNER', 'ADMIN', 'RECEPTIONIST', 'MECHANIC', 'STOREKEEPER', 'ACCOUNTANT', 'XLSX_MANAGER')
  @ApiOperation({ summary: 'UI feature flags (доступно всім авторизованим)' })
  async getUiFeatures(@OrgContext() orgId: string): Promise<UiFeatures> {
    const settings = await this.service.getOrganisationSettings(orgId);
    return settings.uiFeatures;
  }

  @Patch('organisation')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Оновити налаштування організації' })
  @ApiResponse({ status: 200, type: OrganisationSettingsResponseDto })
  updateOrganisation(
    @OrgContext() orgId: string,
    @Body() dto: UpdateOrganisationSettingsDto,
  ) {
    return this.service.updateOrganisationSettings(orgId, dto);
  }

  @Get('branch/:branchId')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Налаштування філії' })
  @ApiResponse({ status: 200, type: BranchSettingsResponseDto })
  getBranch(@OrgContext() orgId: string, @Param('branchId') branchId: string) {
    return this.service.getBranchSettings(orgId, branchId);
  }

  @Patch('branch/:branchId')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Оновити налаштування філії' })
  @ApiResponse({ status: 200, type: BranchSettingsResponseDto })
  updateBranch(
    @OrgContext() orgId: string,
    @Param('branchId') branchId: string,
    @Body() dto: UpdateBranchSettingsDto,
  ) {
    return this.service.updateBranchSettings(orgId, branchId, dto);
  }

  @Get('document-numbers')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Конфігурації нумерації документів' })
  getDocNumbers(@OrgContext() orgId: string) {
    return this.service.getDocumentNumbers(orgId);
  }

  @Patch('document-numbers/:documentType')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Оновити конфігурацію нумерації' })
  updateDocNumber(
    @OrgContext() orgId: string,
    @Param('documentType') documentType: string,
    @Body() dto: UpdateDocNumberDto,
  ) {
    return this.service.updateDocumentNumber(orgId, documentType, dto);
  }

  @Post('document-numbers/:documentType/reset')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Скинути лічильник нумерації' })
  resetDocNumber(@OrgContext() orgId: string, @Param('documentType') documentType: string) {
    return this.service.resetDocumentNumber(orgId, documentType);
  }

  @Get('tax-rates')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  @ApiOperation({ summary: 'Список ставок ПДВ' })
  getTaxRates(@OrgContext() orgId: string) {
    return this.service.getTaxRates(orgId);
  }

  @Post('tax-rates')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Створити ставку ПДВ' })
  createTaxRate(@OrgContext() orgId: string, @Body() dto: CreateTaxRateDto) {
    return this.service.createTaxRate(orgId, dto);
  }

  @Patch('tax-rates/:id')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Оновити ставку ПДВ' })
  updateTaxRate(
    @OrgContext() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaxRateDto,
  ) {
    return this.service.updateTaxRate(orgId, id, dto);
  }

  @Delete('tax-rates/:id')
  @Roles('OWNER', 'ADMIN')
  @ApiOperation({ summary: 'Видалити ставку ПДВ' })
  deleteTaxRate(@OrgContext() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.deleteTaxRate(orgId, id);
  }
}
