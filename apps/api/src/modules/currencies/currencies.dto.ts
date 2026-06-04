import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class CreateCurrencyDto {
  @ApiProperty({ example: 'Гривня' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ example: 'Гривня українська' })
  @IsOptional()
  @IsString()
  fullName?: string;

  @ApiPropertyOptional({ example: 'Ukrainian Hryvnia' })
  @IsOptional()
  @IsString()
  internationalName?: string;

  @ApiProperty({ example: 'UAH' })
  @IsString()
  @IsNotEmpty()
  code!: string;

  @ApiPropertyOptional({ example: '₴' })
  @IsOptional()
  @IsString()
  symbol?: string;

  @ApiPropertyOptional({ description: 'Завантажувати курс з НБУ автоматично' })
  @IsOptional()
  @IsBoolean()
  nbuFetchEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Відсоток нарахування до курсу НБУ (0–100)',
    minimum: 0,
    maximum: 100,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  nbuMarkupPercent?: number | null;
}

export class UpdateCurrencyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  fullName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  internationalName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  symbol?: string;

  @ApiPropertyOptional({ description: 'Завантажувати курс з НБУ автоматично' })
  @IsOptional()
  @IsBoolean()
  nbuFetchEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Відсоток нарахування до курсу НБУ (0–100)',
    minimum: 0,
    maximum: 100,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  nbuMarkupPercent?: number | null;
}

export class CurrencyResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() fullName?: string | null;
  @ApiPropertyOptional() internationalName?: string | null;
  @ApiProperty() code!: string;
  @ApiPropertyOptional() symbol?: string | null;
  @ApiProperty() nbuFetchEnabled!: boolean;
  @ApiPropertyOptional() nbuMarkupPercent?: number | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
