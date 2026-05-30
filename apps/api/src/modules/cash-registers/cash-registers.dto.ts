import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateCashRegisterDto {
  @ApiProperty({ example: 'Каса №1 Головний офіс' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: 'uuid' })
  @IsUUID('4')
  @IsNotEmpty()
  currencyId!: string;

  @ApiProperty({ example: 'uuid' })
  @IsUUID('4')
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
  @IsUUID('4')
  currencyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
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
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
