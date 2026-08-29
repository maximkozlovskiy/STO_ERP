import {
  ArrayMaxSize,
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
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
// Shared regex accepts any UUID including nil UUID (00000000-...) used in seed data.
// class-validator @IsUUID rejects nil UUIDs (version check fails).
import { UUID_REGEX } from '@sto/shared';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

export class CreateWorkDto {
  @ApiProperty()
  @Matches(UUID_REGEX, { message: 'categoryId must be a UUID' })
  categoryId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() name!: string;
  @ApiProperty({ description: 'РќРѕСЂРјРѕ-РіРѕРґРёРЅ' }) @IsNumber() @Min(0) normoHours!: number;
  @ApiProperty({ description: 'Р¦С–РЅР°, в‚ґ' }) @IsNumber() @Min(0) price!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description:
      'Р“Р°СЂР°РЅС‚С–Р№РЅР° СЂРѕР±РѕС‚Р° (РІРёРєРѕРЅСѓС”С‚СЊСЃСЏ Р±РµР·РєРѕС€С‚РѕРІРЅРѕ)',
  })
  @IsOptional()
  @IsBoolean()
  isWarranty?: boolean;
}

export class UpdateWorkDto extends PartialType(CreateWorkDto) {}

export class WorkQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @Matches(UUID_REGEX, { message: 'categoryId must be a UUID' })
  categoryId?: string;

  // РњР°СЃРёРІ ID РєР°С‚РµРіРѕСЂС–Р№ (Р±Р°С‚СЊРєРѕ + РІСЃС– РЅР°С‰Р°РґРєРё) вЂ” РґР»СЏ С„С–Р»СЊС‚СЂР°С†С–С— РїРѕ РїС–РґРґРµСЂРµРІСѓ
  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  // Anti-DoS cap: без ліміту атакувальник з JWT може POST-ити Array(1_000_000).fill(UUID)
  // → ValidationPipe виконає N×regex per element → OOM Node worker. 100 = реалістичний
  // максимум для filter по subtree категорій робіт.
  @ArrayMaxSize(100, { message: 'Не більше 100 категорій у фільтрі' })
  @Matches(UUID_REGEX, { each: true })
  @Transform(({ value }) => (Array.isArray(value) ? value : value ? [value] : undefined))
  categoryIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  q?: string;

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

export class WorkResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() categoryId!: string;
  @ApiProperty() categoryName!: string;
  @ApiProperty() name!: string;
  @ApiProperty() normoHours!: number;
  @ApiProperty() price!: number;
  @ApiPropertyOptional() description!: string | null;
  @ApiProperty() isWarranty!: boolean;
  @ApiPropertyOptional({ type: String, nullable: true }) deletedAt?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class PaginatedWorksDto {
  @ApiProperty({ type: [WorkResponseDto] }) items!: WorkResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
