import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsUUID,
  Matches,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateExchangeRateDto {
  @ApiProperty({ example: 'uuid' })
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  @IsNotEmpty()
  currencyId!: string;

  @ApiProperty({ example: '2026-05-28' })
  @IsDateString()
  date!: string;

  @ApiProperty({ example: 41.5 })
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  rate!: number;

  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional()
  @IsNumber()
  @Min(0.000001)
  @Type(() => Number)
  coefficient?: number;
}

export class UpdateExchangeRateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  date?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  rate?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0.000001)
  @Type(() => Number)
  coefficient?: number;
}

export class ExchangeRateResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() currencyId!: string;
  @ApiProperty() currencyCode!: string;
  @ApiProperty() currencyName!: string;
  @ApiProperty() date!: string;
  @ApiProperty() rate!: number;
  @ApiProperty() coefficient!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
