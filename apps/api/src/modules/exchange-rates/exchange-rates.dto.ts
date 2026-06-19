import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsUUID,
  Min,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

export class CreateExchangeRateDto {
  @ApiProperty({ example: 'uuid' })
  @IsUUID()
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
  @Transform(emptyToUndefined)
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
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}
