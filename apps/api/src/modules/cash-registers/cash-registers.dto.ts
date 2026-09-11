import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';
import { emptyToNull } from '../../common/transforms/empty-to-null';

export class CreateCashRegisterDto {
  @ApiProperty({ example: 'Каса №1 Головний офіс' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: 'uuid' })
  @IsUUID()
  @IsNotEmpty()
  currencyId!: string;

  @ApiProperty({ example: 'uuid' })
  @IsUUID()
  @IsNotEmpty()
  branchId!: string;

  @ApiPropertyOptional({ description: 'Фіскальна каса (операції лише у відкриту зміну + ПРРО)' })
  @IsOptional()
  @IsBoolean()
  isFiscal?: boolean;

  @ApiPropertyOptional({ description: 'Стартовий залишок готівки' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  initialBalance?: number;

  @ApiPropertyOptional({
    description: 'Код ПРРО-провайдера цієї каси (checkbox|vchasno) — з активних на філії',
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  fiscalProvider?: string;

  @ApiPropertyOptional({ description: 'ID каси на боці провайдера (Checkbox cashRegisterId)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  providerCashRegisterId?: string;
}

export class UpdateCashRegisterDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  currencyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isFiscal?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  initialBalance?: number;

  @ApiPropertyOptional({
    description:
      'Код ПРРО-провайдера цієї каси (checkbox|vchasno) — з активних на філії. Порожній рядок ("") очищає прив’язку (null) — напр. коли зняли галочку "Фіскальна каса".',
  })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  fiscalProvider?: string | null;

  @ApiPropertyOptional({
    description:
      'ID каси на боці провайдера (Checkbox cashRegisterId). Порожній рядок ("") очищає значення (null).',
  })
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  providerCashRegisterId?: string | null;
}

export class CashRegisterResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() currencyId!: string;
  @ApiProperty() currencyCode!: string;
  @ApiPropertyOptional() currencySymbol?: string | null;
  @ApiProperty() branchId!: string;
  @ApiProperty() branchName!: string;
  @ApiProperty() isFiscal!: boolean;
  @ApiPropertyOptional({ description: 'Код ПРРО-провайдера цієї каси' })
  fiscalProvider?: string | null;
  @ApiPropertyOptional({ description: 'ID каси на боці провайдера' })
  providerCashRegisterId?: string | null;
  @ApiProperty() initialBalance!: number;
  @ApiProperty({ description: 'Поточний залишок = initialBalance + Σ(sign*amount)' })
  balance!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}
