import { IsString, IsEnum, IsOptional, IsNumber, IsBoolean, IsUUID, Matches, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PricingRuleType, GoodType } from '@prisma/client';
import { Type } from 'class-transformer';

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
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
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
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
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
