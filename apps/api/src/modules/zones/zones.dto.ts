import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ZoneType, LiftType, LiftStatus } from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

// Accepts any UUID including nil UUID (00000000-...) used in seed data.
// @IsUUID() from class-validator rejects nil UUIDs (version check fails).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// в”Ђв”Ђв”Ђ Zone DTOs в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

export class CreateZoneDto {
  @ApiProperty()
  @Matches(UUID_RE, { message: 'branchId must be a UUID' })
  branchId!: string;

  @ApiProperty({ example: 'РњРµС…Р°РЅС–С‡РЅР° Р·РѕРЅР° Рђ' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ enum: ZoneType })
  @IsEnum(ZoneType)
  type!: ZoneType;
}

export class UpdateZoneDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ enum: ZoneType })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(ZoneType)
  type?: ZoneType;
}

export class ZoneResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() branchId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ZoneType }) type!: ZoneType;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional() deletedAt?: string | null;
}

// в”Ђв”Ђв”Ђ Lift DTOs в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

export class CreateLiftDto {
  @ApiProperty()
  @Matches(UUID_RE, { message: 'zoneId must be a UUID' })
  zoneId!: string;

  @ApiProperty({ example: 'РџС–РґР№РѕРјРЅРёРє в„–1' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ enum: LiftType })
  @IsEnum(LiftType)
  type!: LiftType;

  @ApiPropertyOptional({
    example: 3500,
    description: 'РњР°РєСЃРёРјР°Р»СЊРЅР° РІР°РіР°, РєРі (0..50000)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(50000)
  maxWeightKg?: number;
}

export class UpdateLiftDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ enum: LiftType })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(LiftType)
  type?: LiftType;

  @ApiPropertyOptional({
    example: 3500,
    description: 'РњР°РєСЃРёРјР°Р»СЊРЅР° РІР°РіР°, РєРі (0..50000)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(50000)
  maxWeightKg?: number;

  @ApiPropertyOptional({ enum: LiftStatus })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(LiftStatus)
  status?: LiftStatus;

  @ApiPropertyOptional() @IsOptional() @IsString() serialNumber?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  purchaseDate?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  warrantyUntil?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() maintenanceIntervalDays?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  lastMaintenanceDate?: string;
}

export class LiftResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() zoneId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: LiftType }) type!: LiftType;
  @ApiPropertyOptional() maxWeightKg?: number | null;
  @ApiProperty({ enum: LiftStatus }) status!: LiftStatus;
  @ApiPropertyOptional() serialNumber?: string | null;
  @ApiPropertyOptional() purchaseDate?: string | null;
  @ApiPropertyOptional() warrantyUntil?: string | null;
  @ApiPropertyOptional() maintenanceIntervalDays?: number | null;
  @ApiPropertyOptional() lastMaintenanceDate?: string | null;
  @ApiPropertyOptional() nextMaintenanceDate?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional() deletedAt?: string | null;
}
