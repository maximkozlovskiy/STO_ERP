import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ZoneType, LiftType, LiftStatus } from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

// ─── Zone DTOs ───────────────────────────────────────────

export class CreateZoneDto {
  @ApiProperty()
  @IsUUID()
  branchId!: string;

  @ApiProperty({ example: 'Механічна зона А' })
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
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

// ─── Lift DTOs ───────────────────────────────────────────

export class CreateLiftDto {
  @ApiProperty()
  @IsUUID()
  zoneId!: string;

  @ApiProperty({ example: 'Підйомник №1' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ enum: LiftType })
  @IsEnum(LiftType)
  type!: LiftType;

  @ApiPropertyOptional({ example: 3500 })
  @IsOptional()
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

  @ApiPropertyOptional()
  @IsOptional()
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
  @ApiPropertyOptional() purchaseDate?: Date | null;
  @ApiPropertyOptional() warrantyUntil?: Date | null;
  @ApiPropertyOptional() maintenanceIntervalDays?: number | null;
  @ApiPropertyOptional() lastMaintenanceDate?: Date | null;
  @ApiPropertyOptional() nextMaintenanceDate?: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
