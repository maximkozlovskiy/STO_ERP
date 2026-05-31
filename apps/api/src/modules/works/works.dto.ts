import {
  IsString,
  IsNotEmpty,
  IsNumber,
  Matches,
  Min,
  Max,
  IsOptional,
  IsPositive,
  IsBoolean,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

// Accepts any UUID including nil UUID (00000000-...) used in seed data.
// class-validator @IsUUID rejects nil UUIDs (version check fails).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CreateWorkDto {
  @ApiProperty()
  @Matches(UUID_RE, { message: 'categoryId must be a UUID' })
  categoryId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() name!: string;
  @ApiProperty({ description: 'Нормо-годин' }) @IsNumber() @Min(0) normoHours!: number;
  @ApiProperty({ description: 'Ціна, ₴' }) @IsNumber() @Min(0) price!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Гарантійна робота (виконується безкоштовно)' })
  @IsOptional()
  @IsBoolean()
  isWarranty?: boolean;
}

export class UpdateWorkDto extends PartialType(CreateWorkDto) {}

export class WorkQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @Matches(UUID_RE, { message: 'categoryId must be a UUID' })
  categoryId?: string;

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
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class PaginatedWorksDto {
  @ApiProperty({ type: [WorkResponseDto] }) items!: WorkResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
