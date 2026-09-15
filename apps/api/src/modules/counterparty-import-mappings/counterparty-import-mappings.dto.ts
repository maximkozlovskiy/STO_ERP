import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

/** Апсерт мапінгу колонок Excel для контрагента. Колонки 1-based; startRow — рядок першого товару. */
export class UpsertImportMappingDto {
  @ApiPropertyOptional({ default: 2, description: 'Рядок першого товару (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  startRow?: number;

  @ApiPropertyOptional({ description: 'Колонка коду (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  codeCol?: number;

  @ApiPropertyOptional({ description: 'Колонка артикулу (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  articleCol?: number;

  @ApiPropertyOptional({ description: 'Колонка бренду (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  brandCol?: number;

  @ApiPropertyOptional({ description: 'Колонка найменування (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  nameCol?: number;

  @ApiPropertyOptional({ description: 'Колонка кількості (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantityCol?: number;

  @ApiPropertyOptional({ description: 'Колонка ціни (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  priceCol?: number;
}

export class ImportMappingResponseDto {
  @ApiProperty() counterpartyId!: string;
  @ApiProperty() startRow!: number;
  @ApiPropertyOptional() codeCol!: number | null;
  @ApiPropertyOptional() articleCol!: number | null;
  @ApiPropertyOptional() brandCol!: number | null;
  @ApiPropertyOptional() nameCol!: number | null;
  @ApiPropertyOptional() quantityCol!: number | null;
  @ApiPropertyOptional() priceCol!: number | null;
}
