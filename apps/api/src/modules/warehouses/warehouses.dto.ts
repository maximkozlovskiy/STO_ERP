import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import { WarehouseType } from '@prisma/client';

export class CreateWarehouseDto {
  @ApiProperty()
  @IsUUID()
  branchId!: string;

  @ApiProperty({ example: 'Основний склад' })
  @IsString() @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ enum: WarehouseType, default: WarehouseType.MAIN })
  @IsOptional()
  @IsEnum(WarehouseType)
  type?: WarehouseType;
}

export class UpdateWarehouseDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ enum: WarehouseType })
  @IsOptional()
  @IsEnum(WarehouseType)
  type?: WarehouseType;
}

export class WarehouseResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() branchId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: WarehouseType }) type!: WarehouseType;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
