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

  // Колонка у БД — String? (не enum), але @IsEnum тримає запис у межах GoodType:
  // без нього у scope-поле потрапив би довільний рядок і правило не матчило б жоден товар.
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
  @ArrayMaxSize(50, { message: 'err.dto.pricingRule.tiers.max' })
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

  // Див. CreatePricingRuleDto: колонка String?, @IsEnum — вхідна оборона.
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
  @ArrayMaxSize(50, { message: 'err.dto.pricingRule.tiers.max' })
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

// ─── Response DTOs ─────────────────────────────────────────
// Усі 5 роутів раніше повертали inline-форми (`toDto()` без явного типу) →
// `200: {}` у Swagger. Класи, НЕ interface (Swagger читає лише класи).

export class PricingRuleGoodRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) sku!: string | null;
}

export class PricingRuleTierResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() costMin!: number;
  // null → верхня межа відкрита (останній tier).
  @ApiProperty({ type: Number, nullable: true }) costMax!: number | null;
  @ApiProperty() percentValue!: number;
  @ApiProperty() sortOrder!: number;
}

export class PricingRuleResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: PricingRuleType }) type!: PricingRuleType;
  @ApiProperty() priority!: number;
  // Scope-поля взаємовиключні (ієрархія goodId > brandId > goodCategory > goodType);
  // заповнене максимум одне, решта — null.
  @ApiProperty({ type: String, nullable: true }) goodId!: string | null;
  @ApiProperty({ type: PricingRuleGoodRefDto, nullable: true })
  good!: PricingRuleGoodRefDto | null;
  @ApiProperty({ type: String, nullable: true }) goodCategory!: string | null;
  // ВАЖЛИВО: у схемі `PricingRule.goodType` — `String?`, НЕ enum-колонка.
  // Вхідні DTO валідують його через @IsEnum(GoodType) (правильна оборона), але
  // відповідь не може обіцяти enum: у колонці можуть лежати значення поза
  // GoodType (історичні рядки, прямий SQL). Тому `enum` лише як підказка у
  // Swagger-описі, а тип — `string`.
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Очікувані значення — GoodType, але колонка у БД String?',
  })
  goodType!: string | null;
  @ApiProperty({ type: String, nullable: true }) brandId!: string | null;
  @ApiProperty({ type: String, nullable: true }) brandName!: string | null;
  @ApiProperty({ type: String, nullable: true }) supplierId!: string | null;
  @ApiProperty({ type: String, nullable: true }) supplierName!: string | null;
  // Value-поля: релевантне залежить від `type`, решта обнуляються у
  // cleanValuesForType() → null.
  @ApiProperty({ type: Number, nullable: true }) percentValue!: number | null;
  @ApiProperty({ type: Number, nullable: true }) fixedAmount!: number | null;
  @ApiProperty({ type: Number, nullable: true }) fixedPrice!: number | null;
  @ApiProperty({ type: Number, nullable: true }) roundTo!: number | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ type: Date }) createdAt!: Date;
  @ApiProperty({ type: [PricingRuleTierResponseDto] })
  tiers!: PricingRuleTierResponseDto[];
}

// findAll віддає page/limit константами (1/200) — пагінації тут немає, форма
// лишена для сумісності зі списковим контрактом STO ERP.
export class PaginatedPricingRulesDto {
  @ApiProperty({ type: [PricingRuleResponseDto] }) items!: PricingRuleResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

export class ApplyPricingRuleResultDto {
  @ApiProperty({ description: 'Кількість перерахованих товарів' }) updated!: number;
  @ApiProperty({ description: 'Повідомлення для користувача (українською)' }) message!: string;
}
