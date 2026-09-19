import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateUnitDto {
  @ApiProperty({ example: 'штука' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: 'шт' })
  @IsString()
  @IsNotEmpty()
  shortName!: string;

  @ApiPropertyOptional({
    example: 1,
    description: 'Коефіцієнт перерахунку до базової одиниці',
  })
  @IsOptional()
  @IsNumber()
  // coefficient — множник: `qty_base = qty * coefficient` (1 альт. од. = coefficient базових). 0 → guard(safeCoeff)→1.
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

export class UpdateUnitDto {
  @ApiPropertyOptional({ example: 'штука' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional({ example: 'шт' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  shortName?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsNumber()
  // coefficient — множник (qty_base = qty * coefficient); 0 → guard(safeCoeff)→1.
  @Min(0.000001)
  coefficient?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  width?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  height?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  depth?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  volume?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  weight?: number;
}

export class UnitResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() shortName!: string;
  @ApiProperty() isSystem!: boolean;
  @ApiProperty() coefficient!: number;
  @ApiPropertyOptional() width?: number | null;
  @ApiPropertyOptional() height?: number | null;
  @ApiPropertyOptional() depth?: number | null;
  @ApiPropertyOptional() volume?: number | null;
  @ApiPropertyOptional() weight?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) deletedAt?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}
