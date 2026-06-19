import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateBrandDto {
  @ApiProperty({ example: 'BMW' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ type: [String], example: ['БМВ', 'bmw'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  synonyms?: string[];
}

export class UpdateBrandDto {
  @ApiProperty({ example: 'BMW' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ type: [String], example: ['БМВ', 'bmw'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  synonyms?: string[];
}

export class BrandResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: [String] }) synonyms!: string[];
  @ApiPropertyOptional({ type: String, nullable: true }) deletedAt?: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
