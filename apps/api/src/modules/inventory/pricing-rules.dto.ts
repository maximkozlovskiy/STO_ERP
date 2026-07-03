import {
  IsString,
  IsEnum,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsInt,
  IsArray,
  IsUUID,
  Min,
  Max,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PricingRuleType, GoodType } from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

export class PricingRuleTierDto {
  id!: string;
  costMin!: number;
  costMax!: number | null;
  percentValue!: number;
  sortOrder!: number;
}

export class CreatePricingRuleTierDto {
  @ApiProperty()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  costMin!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  costMax?: number;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  @Max(999)
  @Type(() => Number)
  percentValue!: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sortOrder?: number;
}

export class CreatePricingRuleDto {
  @ApiProperty()
  @IsString()
  name!: string;

  @ApiProperty({ enum: PricingRuleType })
  @IsEnum(PricingRuleType)
  type!: PricingRuleType;

  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  priority?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  goodId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  goodCategory?: string;

  // goodType is a GoodType enum in the DB — @IsEnum prevents Postgres 'invalid input value for enum GoodType'.
  @ApiPropertyOptional({ enum: GoodType })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(GoodType)
  goodType?: GoodType;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  brandId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  // Anti-DoS: 50 COST_TIER levels is already absurd for real pricing.
  @ArrayMaxSize(50, { message: 'Не більше 50 рівнів у правилі ціноутворення' })
  @ValidateNested({ each: true })
  @Type(() => CreatePricingRuleTierDto)
  tiers?: CreatePricingRuleTierDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10000)
  percentValue?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  fixedAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  fixedPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  roundTo?: number;
}

export class UpdatePricingRuleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  // emptyToUndefined gap: UpdatePricingRuleDto.type.
  @ApiPropertyOptional({ enum: PricingRuleType })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(PricingRuleType)
  type?: PricingRuleType;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  priority?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  goodId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  goodCategory?: string;

  // goodType is a GoodType enum — not an arbitrary string (see CreatePricingRuleDto).
  // emptyToUndefined gap.
  @ApiPropertyOptional({ enum: GoodType })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(GoodType)
  goodType?: GoodType;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  brandId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  // Anti-DoS: 50 COST_TIER levels is already absurd for real pricing.
  @ArrayMaxSize(50, { message: 'Не більше 50 рівнів у правилі ціноутворення' })
  @ValidateNested({ each: true })
  @Type(() => CreatePricingRuleTierDto)
  tiers?: CreatePricingRuleTierDto[];

  // PATCH must have the same validators as POST — without Min(0), `percentValue: -50`
  // would set salePrice = costPrice * 0.5 (selling below cost).
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(10000)
  percentValue?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  fixedAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  fixedPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  roundTo?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
