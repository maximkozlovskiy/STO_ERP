import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsArray,
  Matches,
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
  @ApiPropertyOptional({ default: 'С€С‚' }) @IsOptional() @IsString() unit?: string;
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
  @ApiPropertyOptional({ description: 'UUID РєР°С‚РµРіРѕСЂС–С— С‚РѕРІР°СЂС–РІ (GoodCategory)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  goodCategoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() barcode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  // Bug #262: emptyToUndefined gap вЂ” UpdateGoodDto extends PartialType СѓСЃРїР°РґРєРѕРІСѓС” С†РµР№ Р±Р°Рі.
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class GoodQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() q?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() barcode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() category?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() goodCategoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @Matches(UUID_RE, { each: true })
  @Transform(({ value }) => (Array.isArray(value) ? value : value ? [value] : undefined))
  goodCategoryIds?: string[];

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

  @ApiPropertyOptional({ description: 'РџРѕРєР°Р·Р°С‚Рё РІРёРґР°Р»РµРЅС–' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  showDeleted?: boolean;
}

export class GoodResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiPropertyOptional() internalCode!: string | null;
  @ApiPropertyOptional() sku!: string | null;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() brandName?: string | null;
  @ApiProperty() unit!: string;
  @ApiPropertyOptional() unitId?: string | null;
  @ApiPropertyOptional() brandId?: string | null;
  @ApiPropertyOptional() purchasePrice!: number | null;
  @ApiProperty() salePrice!: number;
  @ApiPropertyOptional() category!: string | null;
  @ApiPropertyOptional() goodCategoryId?: string | null;
  @ApiPropertyOptional() goodCategoryName?: string | null;
  @ApiPropertyOptional() barcode!: string | null;
  @ApiPropertyOptional() notes!: string | null;
  @ApiPropertyOptional({ enum: GoodType }) goodType?: GoodType | null;
  @ApiPropertyOptional() preferredSupplierId?: string | null;
  @ApiPropertyOptional() preferredSupplierName?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) deletedAt?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class PaginatedGoodsDto {
  @ApiProperty({ type: [GoodResponseDto] }) items!: GoodResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

// в”Ђв”Ђв”Ђ Good UoM в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

export class CreateGoodUoMDto {
  @ApiProperty({ description: 'ID РѕРґРёРЅРёС†С– РІРёРјС–СЂСѓ' })
  @IsUUID('4')
  unitOfMeasureId!: string;

  @ApiPropertyOptional({
    example: 1,
    description: 'РљРѕРµС„С–С†С–С”РЅС‚ РїРµСЂРµСЂР°С…СѓРЅРєСѓ (default: Р· UnitOfMeasure)',
  })
  @IsOptional()
  @IsNumber()
  // Bug #312: coefficient=0 в†’ divide-by-zero Сѓ qty_base. РўРѕР№ СЃР°РјРёР№ guard С‰Рѕ Bug #302 РґР»СЏ UnitOfMeasure DTO.
  @Min(0.000001)
  coefficient?: number;

  @ApiPropertyOptional({ description: 'РЁРёСЂРёРЅР° (Рј)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  width?: number;

  @ApiPropertyOptional({ description: 'Р’РёСЃРѕС‚Р° (Рј)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  height?: number;

  @ApiPropertyOptional({ description: 'Р“Р»РёР±РёРЅР°/РґРѕРІР¶РёРЅР° (Рј)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  depth?: number;

  @ApiPropertyOptional({ description: "РћР±'С”Рј (РјВі)" })
  @IsOptional()
  @IsNumber()
  @Min(0)
  volume?: number;

  @ApiPropertyOptional({ description: 'Р’Р°РіР° (РєРі)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  weight?: number;
}

export class UpdateGoodUoMDto {
  @ApiPropertyOptional({
    example: 1,
    description: 'РљРѕРµС„С–С†С–С”РЅС‚ РїРµСЂРµСЂР°С…СѓРЅРєСѓ РґРѕ Р±Р°Р·РѕРІРѕС— РѕРґРёРЅРёС†С–',
  })
  @IsOptional()
  @IsNumber()
  // Bug #312: coefficient=0 в†’ divide-by-zero. РўРѕР№ СЃР°РјРёР№ guard С‰Рѕ Сѓ CreateGoodUoMDto.
  @Min(0.000001)
  coefficient?: number;

  @ApiPropertyOptional({ description: 'РЁРёСЂРёРЅР° (Рј)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  width?: number;

  @ApiPropertyOptional({ description: 'Р’РёСЃРѕС‚Р° (Рј)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  height?: number;

  @ApiPropertyOptional({ description: 'Р“Р»РёР±РёРЅР°/РґРѕРІР¶РёРЅР° (Рј)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  depth?: number;

  @ApiPropertyOptional({ description: "РћР±'С”Рј (РјВі)" })
  @IsOptional()
  @IsNumber()
  @Min(0)
  volume?: number;

  @ApiPropertyOptional({ description: 'Р’Р°РіР° (РєРі)' })
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
