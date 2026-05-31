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

  // Bug #33: goodType — це enum GoodType у БД, тому валідуємо як enum.
  // Без @IsEnum довільний рядок проходив DTO і валив `applyRuleToGoods` runtime exception
  // (`invalid input value for enum GoodType`).
  @ApiPropertyOptional({ enum: GoodType })
  @IsOptional()
  @IsEnum(GoodType)
  goodType?: GoodType;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  brandId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  // Bug #248: anti-DoS cap. COST_TIER з 50 рівнями — і так абсурд для реальної ціноутворення.
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

  @ApiPropertyOptional({ enum: PricingRuleType })
  @IsOptional()
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

  // Bug #33: goodType — enum, не довільний рядок (див. CreatePricingRuleDto).
  @ApiPropertyOptional({ enum: GoodType })
  @IsOptional()
  @IsEnum(GoodType)
  goodType?: GoodType;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  brandId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  // Bug #248: anti-DoS cap. COST_TIER з 50 рівнями — і так абсурд для реальної ціноутворення.
  @ArrayMaxSize(50, { message: 'Не більше 50 рівнів у правилі ціноутворення' })
  @ValidateNested({ each: true })
  @Type(() => CreatePricingRuleTierDto)
  tiers?: CreatePricingRuleTierDto[];

  // Bug #27: PATCH повинен мати ті самі валідатори, що й POST,
  // інакше ціна продажу може стати від'ємною (`percentValue: -50` → costPrice * 0.5).
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
