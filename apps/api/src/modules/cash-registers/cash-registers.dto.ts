import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

export class CreateCashRegisterDto {
  @ApiProperty({ example: 'РљР°СЃР° в„–1 Р“РѕР»РѕРІРЅРёР№ РѕС„С–СЃ' })
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
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}
