import {
  IsString,
  IsNotEmpty,
  IsUUID,
  IsNumber,
  Min,
  Max,
  IsOptional,
  IsPositive,
  IsBoolean,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateWorkDto {
  @ApiProperty()
  @IsUUID('4')
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
  @IsUUID('4')
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
