import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateUnitDto {
  @ApiProperty({ example: 'С€С‚СѓРєР°' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: 'С€С‚' })
  @IsString()
  @IsNotEmpty()
  shortName!: string;

  @ApiPropertyOptional({
    example: 1,
    description: 'РљРѕРµС„С–С†С–С”РЅС‚ РїРµСЂРµСЂР°С…СѓРЅРєСѓ РґРѕ Р±Р°Р·РѕРІРѕС— РѕРґРёРЅРёС†С–',
  })
  @IsOptional()
  @IsNumber()
  // coefficient is a divisor: `qty_base = qty / coefficient` (work-orders, purchase-orders, invoices). 0 → Infinity → silent NaN propagation.
  @Min(0.000001)
  coefficient?: number;

  @ApiPropertyOptional({ description: 'РЁРёСЂРёРЅР° (Рј)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  width?: number;

  @ApiPropertyOptional({ description: 'Р’РёСЃРѕС‚Р° (Рј)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  height?: number;

  @ApiPropertyOptional({ description: 'Р“Р»РёР±РёРЅР°/РґРѕРІР¶РёРЅР° (Рј)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  depth?: number;

  @ApiPropertyOptional({ description: "РћР±'С”Рј (РјВі)" })
  @IsOptional()
  @IsNumber()
  @Min(0)
  volume?: number;

  @ApiPropertyOptional({ description: 'Р’Р°РіР° (РєРі)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  weight?: number;
}

export class UpdateUnitDto {
  @ApiPropertyOptional({ example: 'С€С‚СѓРєР°' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional({ example: 'С€С‚' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  shortName?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsNumber()
  // coefficient is a divisor — 0 causes Infinity → silent NaN propagation.
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
