import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { VatMode, BatchCostMethod } from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';
import { toUpperCurrencyCode } from '../../common/transforms/to-upper-currency-code';

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
  // ISO 4217 РІР°Р»СЋС‚Р° РѕР±Р»С–РєСѓ вЂ” РїРѕСЃРёР»Р°С”С‚СЊСЃСЏ РЅР° Currency.code (3-10 СЃРёРјРІРѕР»С–РІ).
  // Bug review (currency feature): Р±РµР· РїРѕР»СЏ Сѓ DTO `forbidNonWhitelisted: true`
  // РіР»РѕР±Р°Р»СЊРЅРѕ РІС–РґС…РёР»СЏРІ PATCH Р· `currency` в†’ save РІР°Р»СЋС‚Рё Сѓ Settings в†’ Org РјРѕРІС‡РєРё
  // С„РµР№Р»РёРІСЃСЏ 400-РєРѕСЋ РґР»СЏ РєРѕСЂРёСЃС‚СѓРІР°С‡Р°.
  // toUpperCurrencyCode РЅРѕСЂРјР°Р»С–Р·СѓС” `uah` в†’ `UAH` + trim + @MaxLength(10)
  // anti-DoS. Currency.code @db.VarChar(10) Сѓ СЃС…РµРјС– вЂ” РїРѕР·Р° 10 СЃРёРјРІРѕР»С–РІ РЅРµ РїСЂРѕР№РґРµ.
  @ApiPropertyOptional({ description: 'ISO РєРѕРґ РІР°Р»СЋС‚Рё РѕР±Р»С–РєСѓ (UAH, USD, EUR)' })
  @IsOptional()
  @Transform(toUpperCurrencyCode)
  @IsString()
  @MaxLength(10, {
    message: 'РљРѕРґ РІР°Р»СЋС‚Рё РЅРµ РјРѕР¶Рµ РїРµСЂРµРІРёС‰СѓРІР°С‚Рё 10 СЃРёРјРІРѕР»С–РІ',
  })
  currency?: string;

  // emptyToUndefined gap вЂ” settings selects Р· default `''` в†’ 400.
  @ApiPropertyOptional({ enum: VatMode })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(VatMode)
  vatMode?: VatMode;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
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

  // emptyToUndefined gap.
  @ApiPropertyOptional({ enum: BatchCostMethod })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(BatchCostMethod)
  costMethod?: BatchCostMethod;

  // B8: follow-up reminder settings. Bug #84 вЂ” Schema/DB had these fields, but
  // DTO/whitelist silently dropped them on PATCH and they never came back on GET.
  @ApiPropertyOptional({ description: 'РђРєС‚РёРІСѓРІР°С‚Рё follow-up РЅР°РіР°РґСѓРІР°РЅРЅСЏ' })
  @IsOptional()
  @IsBoolean()
  followUpActive?: boolean;

  @ApiPropertyOptional({
    minimum: 30,
    maximum: 365,
    description: 'РџРѕСЂС–Рі РґРЅС–РІ Р±РµР· РІС–Р·РёС‚Сѓ',
  })
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(365)
  followUpDays?: number;

  @ApiPropertyOptional({
    description: 'Р“РѕРґРёРЅР° Р°РІС‚РѕР·Р°РІР°РЅС‚Р°Р¶РµРЅРЅСЏ РєСѓСЂСЃС–РІ РќР‘РЈ (0вЂ“23)',
    minimum: 0,
    maximum: 23,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  nbuFetchHour?: number;

  @ApiPropertyOptional({ description: 'UI feature flags (partial update supported)' })
  @IsOptional()
  @IsObject()
  uiFeatures?: Partial<UiFeatures>;

  // B4: Loyalty program
  @ApiPropertyOptional({ description: 'РЈРІС–РјРєРЅСѓС‚Рё РїСЂРѕРіСЂР°РјСѓ Р»РѕСЏР»СЊРЅРѕСЃС‚С–' })
  @IsOptional()
  @IsBoolean()
  loyaltyEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'РќР°СЂР°С…РѕРІСѓРІР°С‚Рё Р±Р°Р»Рё Р·Р° РєРѕР¶РЅС– N РіСЂРЅ',
    minimum: 1,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  loyaltyEarnPer?: number;

  @ApiPropertyOptional({ description: 'РљС–Р»СЊРєС–СЃС‚СЊ Р±Р°Р»С–РІ Р·Р° N РіСЂРЅ', minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  loyaltyEarnPoints?: number;

  @ApiPropertyOptional({ description: '1 Р±Р°Р» = N РіСЂРЅ Р·РЅРёР¶РєРё', minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  loyaltyRedeemRate?: number;

  @ApiPropertyOptional({
    description:
      'РџРµСЂРµСЂР°С…РѕРІСѓРІР°С‚Рё РїР»Р°РЅРѕРІС– РЅРѕСЂРјРѕРіРѕРґРёРЅРё РїРѕ СЃСѓРјС– СЂСЏРґРєС–РІ СЂРѕР±С–С‚',
  })
  @IsOptional()
  @IsBoolean()
  recalcPlannedHoursFromLines?: boolean;

  @ApiPropertyOptional({
    description:
      'РџРµСЂРµСЂР°С…РѕРІСѓРІР°С‚Рё С„Р°РєС‚РёС‡РЅС– РЅРѕСЂРјРѕРіРѕРґРёРЅРё РїРѕ СЃСѓРјС– СЂСЏРґРєС–РІ СЂРѕР±С–С‚',
  })
  @IsOptional()
  @IsBoolean()
  recalcActualHoursFromLines?: boolean;

  @ApiPropertyOptional({
    description:
      'РЎРёРЅС…СЂРѕРЅС–Р·СѓРІР°С‚Рё СЃР»РѕС‚ РєР°Р»РµРЅРґР°СЂСЏ РїСЂРё Р·РјС–РЅС– РїР»Р°РЅРѕРІРёС… РіРѕРґРёРЅ РЅР°СЂСЏРґСѓ',
  })
  @IsOptional()
  @IsBoolean()
  syncCalendarSlotWithPlannedHours?: boolean;
}

// HH:MM regex (00:00вЂ“23:59). Р‘РµР· regex backend РїСЂРёР№РјР°С” 'foo'/'25:99' в†’
// Р‘Р” РєРѕСЂСѓРјРїРѕРІР°РЅР° в†’ getBranchSettings РїРѕРІРµСЂС‚Р°С” СЃРјС–С‚С‚СЏ в†’ frontend settings form
// РїРѕРєР°Р·СѓС” РЅРµРІР°Р»С–РґРЅС– Р·РЅР°С‡РµРЅРЅСЏ; gorshe вЂ” workStartTime='20:00' + workEndTime='09:00'
// РїСЂРѕС…РѕРґРёС‚СЊ (РѕР±РёРґРІР° РІР°Р»С–РґРЅС– СЃС‚СЂРѕРєРё) в†’ getWorkHours РїРѕРІРµСЂС‚Р°С” С–РЅРІРµСЂС‚РѕРІР°РЅС– РіРѕРґРёРЅРё в†’
// frontend dynHours=[] в†’ NaN Сѓ CSS в†’ DOM crash.
const HH_MM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export class UpdateBranchSettingsDto {
  @ApiPropertyOptional({ example: '09:00' })
  @IsOptional()
  @IsString()
  @Matches(HH_MM_RE, { message: 'Формат “ГГ:ХХ” (00:00–23:59)' })
  workStartTime?: string;

  @ApiPropertyOptional({ example: '18:00' })
  @IsOptional()
  @IsString()
  @Matches(HH_MM_RE, { message: 'Формат “ГГ:ХХ” (00:00–23:59)' })
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

  @ApiPropertyOptional({
    description: 'Р РѕР±РѕС‡С– РґРЅС– С‚РёР¶РЅСЏ (0=РЅРґ, 1=РїРЅ, ..., 6=СЃР±)',
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  workDays?: number[];
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
  @ApiProperty({
    description: 'Р“РѕРґРёРЅР° Р°РІС‚РѕР·Р°РІР°РЅС‚Р°Р¶РµРЅРЅСЏ РєСѓСЂСЃС–РІ РќР‘РЈ (0вЂ“23)',
  })
  nbuFetchHour!: number;
  @ApiProperty({ description: 'UI feature flags' }) uiFeatures!: UiFeatures;
  // B4: Loyalty
  @ApiProperty() loyaltyEnabled!: boolean;
  @ApiProperty() loyaltyEarnPer!: number;
  @ApiProperty() loyaltyEarnPoints!: number;
  @ApiProperty() loyaltyRedeemRate!: number;
  @ApiProperty({
    description:
      'РџРµСЂРµСЂР°С…РѕРІСѓРІР°С‚Рё РїР»Р°РЅРѕРІС– РЅРѕСЂРјРѕРіРѕРґРёРЅРё РїРѕ СЃСѓРјС– СЂСЏРґРєС–РІ СЂРѕР±С–С‚',
  })
  recalcPlannedHoursFromLines!: boolean;
  @ApiProperty({
    description:
      'РџРµСЂРµСЂР°С…РѕРІСѓРІР°С‚Рё С„Р°РєС‚РёС‡РЅС– РЅРѕСЂРјРѕРіРѕРґРёРЅРё РїРѕ СЃСѓРјС– СЂСЏРґРєС–РІ СЂРѕР±С–С‚',
  })
  recalcActualHoursFromLines!: boolean;
  @ApiProperty({
    description:
      'РЎРёРЅС…СЂРѕРЅС–Р·СѓРІР°С‚Рё СЃР»РѕС‚ РєР°Р»РµРЅРґР°СЂСЏ РїСЂРё Р·РјС–РЅС– РїР»Р°РЅРѕРІРёС… РіРѕРґРёРЅ РЅР°СЂСЏРґСѓ',
  })
  syncCalendarSlotWithPlannedHours!: boolean;
  @ApiProperty() updatedAt!: string;
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
  @ApiProperty() updatedAt!: string;
}

export class WorkHoursDto {
  @ApiProperty({ example: 8, description: 'Р“РѕРґРёРЅР° РїРѕС‡Р°С‚РєСѓ СЂРѕР±РѕС‚Рё (0-23)' })
  workStartHour!: number;
  @ApiProperty({ example: 18, description: 'Р“РѕРґРёРЅР° РєС–РЅС†СЏ СЂРѕР±РѕС‚Рё (0-23)' })
  workEndHour!: number;
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
  @Transform(emptyToUndefined)
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
  @ApiProperty() updatedAt!: string;
}
