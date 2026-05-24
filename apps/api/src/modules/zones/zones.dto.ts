import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import { ZoneType, LiftType } from '@prisma/client';

// ─── Zone DTOs ───────────────────────────────────────────

export class CreateZoneDto {
  @ApiProperty()
  @IsUUID()
  branchId!: string;

  @ApiProperty({ example: 'Механічна зона А' })
  @IsString() @IsNotEmpty()
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
  @IsString() @IsNotEmpty()
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
  @IsEnum(LiftType)
  type?: LiftType;

  @ApiPropertyOptional()
  @IsOptional()
  maxWeightKg?: number;
}

export class LiftResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() zoneId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: LiftType }) type!: LiftType;
  @ApiPropertyOptional() maxWeightKg?: number | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
