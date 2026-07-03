import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateBrandDto {
  @ApiProperty({ example: 'BMW' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ type: [String], example: ['БМВ', 'bmw'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20, { message: 'Не більше 20 синонімів' })
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  synonyms?: string[];
}

export class UpdateBrandDto {
  @ApiProperty({ example: 'BMW' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ type: [String], example: ['БМВ', 'bmw'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20, { message: 'Не більше 20 синонімів' })
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  synonyms?: string[];
}

export class BrandResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: [String] }) synonyms!: string[];
  @ApiPropertyOptional({ type: String, nullable: true }) deletedAt?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}
