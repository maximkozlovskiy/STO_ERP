import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { WarehouseType } from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

// Accepts nil UUIDs used in seed data (class-validator @IsUUID rejects nil UUIDs).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CreateWarehouseDto {
  @ApiProperty()
  @Matches(UUID_RE, { message: 'branchId must be a UUID' })
  branchId!: string;

  @ApiProperty({ example: 'РћСЃРЅРѕРІРЅРёР№ СЃРєР»Р°Рґ' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ enum: WarehouseType, default: WarehouseType.MAIN })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(WarehouseType)
  type?: WarehouseType;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isMain?: boolean;
}

export class UpdateWarehouseDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ enum: WarehouseType })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(WarehouseType)
  type?: WarehouseType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isMain?: boolean;
}

export class WarehouseResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() branchId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: WarehouseType }) type!: WarehouseType;
  @ApiProperty() isMain!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional() deletedAt?: string | null;
}
