import {
  IsString,
  IsNotEmpty,
  IsNumber,
  Min,
  Max,
  IsOptional,
  IsPositive,
  IsBoolean,
  IsEnum,
  IsUUID,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { GoodType } from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

export class CreateGoodDto {
  @ApiPropertyOptional() @IsOptional() @IsString() sku?: string;
  @ApiProperty() @IsString() @IsNotEmpty() name!: string;
  @ApiPropertyOptional({ default: 'шт' }) @IsOptional() @IsString() unit?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  unitId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  brandId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  purchasePrice?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  salePrice?: number;

  @ApiPropertyOptional() @IsOptional() @IsString() category?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() barcode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  // Bug #262: emptyToUndefined gap — UpdateGoodDto extends PartialType успадковує цей баг.
  @ApiPropertyOptional({ enum: GoodType })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(GoodType)
  goodType?: GoodType;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  preferredSupplierId?: string;
}

export class UpdateGoodDto extends PartialType(CreateGoodDto) {}

export class GoodQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() q?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() barcode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() category?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  @Max(200)
  limit: number = 50;

  @ApiPropertyOptional({ description: 'Показати видалені' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  showDeleted?: boolean;
}

export class GoodResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiPropertyOptional() sku!: string | null;
  @ApiProperty() name!: string;
  @ApiProperty() unit!: string;
  @ApiPropertyOptional() unitId?: string | null;
  @ApiPropertyOptional() brandId?: string | null;
  @ApiPropertyOptional() purchasePrice!: number | null;
  @ApiProperty() salePrice!: number;
  @ApiPropertyOptional() category!: string | null;
  @ApiPropertyOptional() barcode!: string | null;
  @ApiPropertyOptional() notes!: string | null;
  @ApiPropertyOptional({ enum: GoodType }) goodType?: GoodType | null;
  @ApiPropertyOptional() preferredSupplierId?: string | null;
  @ApiPropertyOptional() preferredSupplierName?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) deletedAt?: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class PaginatedGoodsDto {
  @ApiProperty({ type: [GoodResponseDto] }) items!: GoodResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

// ─── Good UoM ────────────────────────────────────────────────────────────────

export class CreateGoodUoMDto {
  @ApiProperty({ description: 'ID одиниці виміру' })
  @IsUUID('4')
  unitOfMeasureId!: string;

  @ApiPropertyOptional({
    example: 1,
    description: 'Коефіцієнт перерахунку (default: з UnitOfMeasure)',
  })
  @IsOptional()
  @IsNumber()
  // Bug #312: coefficient=0 → divide-by-zero у qty_base. Той самий guard що Bug #302 для UnitOfMeasure DTO.
  @Min(0.000001)
  coefficient?: number;

  @ApiPropertyOptional({ description: 'Ширина (м)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  width?: number;

  @ApiPropertyOptional({ description: 'Висота (м)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  height?: number;

  @ApiPropertyOptional({ description: 'Глибина/довжина (м)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  depth?: number;

  @ApiPropertyOptional({ description: "Об'єм (м³)" })
  @IsOptional()
  @IsNumber()
  @Min(0)
  volume?: number;

  @ApiPropertyOptional({ description: 'Вага (кг)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  weight?: number;
}

export class UpdateGoodUoMDto {
  @ApiPropertyOptional({ example: 1, description: 'Коефіцієнт перерахунку до базової одиниці' })
  @IsOptional()
  @IsNumber()
  // Bug #312: coefficient=0 → divide-by-zero. Той самий guard що у CreateGoodUoMDto.
  @Min(0.000001)
  coefficient?: number;

  @ApiPropertyOptional({ description: 'Ширина (м)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  width?: number;

  @ApiPropertyOptional({ description: 'Висота (м)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  height?: number;

  @ApiPropertyOptional({ description: 'Глибина/довжина (м)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  depth?: number;

  @ApiPropertyOptional({ description: "Об'єм (м³)" })
  @IsOptional()
  @IsNumber()
  @Min(0)
  volume?: number;

  @ApiPropertyOptional({ description: 'Вага (кг)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  weight?: number;
}

export class GoodUoMResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() unitOfMeasureId!: string;
  @ApiProperty() unitName!: string;
  @ApiProperty() unitShortName!: string;
  @ApiProperty() coefficient!: number;
  @ApiProperty() isDefault!: boolean;
  @ApiPropertyOptional() width?: number | null;
  @ApiPropertyOptional() height?: number | null;
  @ApiPropertyOptional() depth?: number | null;
  @ApiPropertyOptional() volume?: number | null;
  @ApiPropertyOptional() weight?: number | null;
}
