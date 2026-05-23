import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { VatMode } from '@prisma/client';

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
