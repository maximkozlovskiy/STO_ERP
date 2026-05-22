import { IsString, IsNotEmpty, IsUUID, IsNumber, Min, IsOptional, IsPositive } from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateWorkDto {
  @ApiProperty() @IsUUID() categoryId!: string;
  @ApiProperty() @IsString() @IsNotEmpty() name!: string;
  @ApiProperty({ description: 'Нормо-годин' }) @IsNumber() @Min(0) normoHours!: number;
  @ApiProperty({ description: 'Ціна, ₴' }) @IsNumber() @Min(0) price!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateWorkDto extends PartialType(CreateWorkDto) {}

export class WorkQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
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
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class PaginatedWorksDto {
  @ApiProperty({ type: [WorkResponseDto] }) items!: WorkResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
