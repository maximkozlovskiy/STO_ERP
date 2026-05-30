import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { VatMode, BatchCostMethod } from '@prisma/client';

export interface UiFeatures {
  toastEnabled: boolean;
  unsavedGuardEnabled: boolean;
  stockIndicatorEnabled: boolean;
  commandPaletteEnabled: boolean;
  keyboardShortcutsEnabled: boolean;
  savedFiltersEnabled: boolean;
  inlineEditEnabled: boolean;
  syncIndicatorEnabled: boolean;
  notificationCenterEnabled: boolean;
  bulkActionsEnabled: boolean;
}

export const UI_FEATURES_DEFAULTS: UiFeatures = {
  toastEnabled: true,
  unsavedGuardEnabled: true,
  stockIndicatorEnabled: true,
  commandPaletteEnabled: true,
  keyboardShortcutsEnabled: true,
  savedFiltersEnabled: true,
  inlineEditEnabled: true,
  syncIndicatorEnabled: true,
  notificationCenterEnabled: true,
  bulkActionsEnabled: true,
};

export class UpdateOrganisationSettingsDto {
  @ApiPropertyOptional({ enum: VatMode })
  @IsOptional()
  @IsEnum(VatMode)
  vatMode?: VatMode;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  defaultVatRateId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 365 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  invoiceDueDays?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 365 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  autoArchiveDays?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 3650 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  defaultWarrantyDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requireClientApproval?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowPartialPayment?: boolean;

  @ApiPropertyOptional({ enum: ['blue', 'green', 'purple', 'orange', 'gray'] })
  @IsOptional()
  @IsString()
  brandTheme?: string;

  @ApiPropertyOptional({ enum: BatchCostMethod })
  @IsOptional()
  @IsEnum(BatchCostMethod)
  costMethod?: BatchCostMethod;

  // B8: follow-up reminder settings. Bug #84 — Schema/DB had these fields, but
  // DTO/whitelist silently dropped them on PATCH and they never came back on GET.
  @ApiPropertyOptional({ description: 'Активувати follow-up нагадування' })
  @IsOptional()
  @IsBoolean()
  followUpActive?: boolean;

  @ApiPropertyOptional({ minimum: 30, maximum: 365, description: 'Поріг днів без візиту' })
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(365)
  followUpDays?: number;

  @ApiPropertyOptional({ description: 'UI feature flags (partial update supported)' })
  @IsOptional()
  @IsObject()
  uiFeatures?: Partial<UiFeatures>;

  // B4: Loyalty program
  @ApiPropertyOptional({ description: 'Увімкнути програму лояльності' })
  @IsOptional()
  @IsBoolean()
  loyaltyEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Нараховувати бали за кожні N грн', minimum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  loyaltyEarnPer?: number;

  @ApiPropertyOptional({ description: 'Кількість балів за N грн', minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  loyaltyEarnPoints?: number;

  @ApiPropertyOptional({ description: '1 бал = N грн знижки', minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  loyaltyRedeemRate?: number;
}

export class UpdateBranchSettingsDto {
  @ApiPropertyOptional({ example: '09:00' })
  @IsOptional()
  @IsString()
  workStartTime?: string;

  @ApiPropertyOptional({ example: '18:00' })
  @IsOptional()
  @IsString()
  workEndTime?: string;

  @ApiPropertyOptional({ minimum: 15, maximum: 240 })
  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(240)
  slotDurationMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  fiscalEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  checkboxApiUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  checkboxLicenseKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  checkboxPinCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  checkboxCashRegisterId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  smsEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  smsProvider?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  smsApiKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  smsSenderName?: string;
}

export class OrganisationSettingsResponseDto {
  @ApiProperty() orgId!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: VatMode }) vatMode!: VatMode;
  @ApiPropertyOptional() defaultVatRateId?: string | null;
  @ApiProperty() invoiceDueDays!: number;
  @ApiProperty() autoArchiveDays!: number;
  @ApiProperty() defaultWarrantyDays!: number;
  @ApiProperty() requireClientApproval!: boolean;
  @ApiProperty() allowPartialPayment!: boolean;
  @ApiProperty() brandTheme!: string;
  @ApiProperty({ enum: BatchCostMethod }) costMethod!: BatchCostMethod;
  @ApiProperty() followUpActive!: boolean;
  @ApiProperty() followUpDays!: number;
  @ApiProperty({ description: 'UI feature flags' }) uiFeatures!: UiFeatures;
  // B4: Loyalty
  @ApiProperty() loyaltyEnabled!: boolean;
  @ApiProperty() loyaltyEarnPer!: number;
  @ApiProperty() loyaltyEarnPoints!: number;
  @ApiProperty() loyaltyRedeemRate!: number;
  @ApiProperty() updatedAt!: Date;
}

export class BranchSettingsResponseDto {
  @ApiProperty() branchId!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() workStartTime!: string;
  @ApiProperty() workEndTime!: string;
  @ApiProperty() workDays!: number[];
  @ApiProperty() slotDurationMinutes!: number;
  @ApiProperty() fiscalEnabled!: boolean;
  @ApiPropertyOptional() checkboxApiUrl?: string | null;
  @ApiPropertyOptional() checkboxCashRegisterId?: string | null;
  @ApiProperty() smsEnabled!: boolean;
  @ApiPropertyOptional() smsProvider?: string | null;
  @ApiPropertyOptional() smsSenderName?: string | null;
  @ApiProperty() updatedAt!: Date;
}

export class UpdateOrganisationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  edrpou?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf(o => o.logoUrl !== null)
  @IsString()
  logoUrl?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf(o => o.legalAddress !== null)
  @IsString()
  legalAddress?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf(o => o.actualAddress !== null)
  @IsString()
  actualAddress?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf(o => o.bankAccountId !== null)
  @IsUUID()
  bankAccountId?: string | null;
}

export class OrganisationResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() edrpou?: string | null;
  @ApiPropertyOptional() logoUrl?: string | null;
  @ApiPropertyOptional() legalAddress?: string | null;
  @ApiPropertyOptional() actualAddress?: string | null;
  @ApiPropertyOptional() bankAccountId?: string | null;
  @ApiProperty() updatedAt!: Date;
}
