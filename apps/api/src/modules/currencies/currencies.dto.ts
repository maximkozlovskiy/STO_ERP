import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class CreateCurrencyDto {
  @ApiProperty({ example: 'Р“СЂРёРІРЅСЏ' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ example: 'Р“СЂРёРІРЅСЏ СѓРєСЂР°С—РЅСЃСЊРєР°' })
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

  @ApiPropertyOptional({ example: 'в‚ґ' })
  @IsOptional()
  @IsString()
  symbol?: string;

  @ApiPropertyOptional({
    description: 'Р—Р°РІР°РЅС‚Р°Р¶СѓРІР°С‚Рё РєСѓСЂСЃ Р· РќР‘РЈ Р°РІС‚РѕРјР°С‚РёС‡РЅРѕ',
  })
  @IsOptional()
  @IsBoolean()
  nbuFetchEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Р’С–РґСЃРѕС‚РѕРє РЅР°СЂР°С…СѓРІР°РЅРЅСЏ РґРѕ РєСѓСЂСЃСѓ РќР‘РЈ (0вЂ“100)',
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

  @ApiPropertyOptional({
    description: 'Р—Р°РІР°РЅС‚Р°Р¶СѓРІР°С‚Рё РєСѓСЂСЃ Р· РќР‘РЈ Р°РІС‚РѕРјР°С‚РёС‡РЅРѕ',
  })
  @IsOptional()
  @IsBoolean()
  nbuFetchEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Р’С–РґСЃРѕС‚РѕРє РЅР°СЂР°С…СѓРІР°РЅРЅСЏ РґРѕ РєСѓСЂСЃСѓ РќР‘РЈ (0вЂ“100)',
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
  @ApiProperty() isSystem!: boolean;
  @ApiProperty() nbuFetchEnabled!: boolean;
  @ApiPropertyOptional() nbuMarkupPercent?: number | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}
