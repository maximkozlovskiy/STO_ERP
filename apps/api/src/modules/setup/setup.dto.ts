import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class SetupInitDto {
  // Organisation
  @ApiProperty({ example: 'СТО Авто-Майстер' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  orgName!: string;

  @ApiPropertyOptional({ example: '12345678' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  edrpou?: string;

  // Owner account
  @ApiProperty({ example: 'owner@sto.local' })
  @IsEmail({}, { message: 'Невірний формат email' })
  @MaxLength(254)
  ownerEmail!: string;

  @ApiProperty({ example: 'secret', minLength: 6 })
  @IsString()
  @IsNotEmpty({ message: 'Пароль не може бути порожнім' })
  @MinLength(6, { message: 'Пароль має бути не менше 6 символів' })
  @MaxLength(128, { message: 'Пароль занадто довгий (максимум 128 символів)' })
  ownerPassword!: string;

  @ApiProperty({ example: 'Іван' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  ownerFirstName!: string;

  @ApiProperty({ example: 'Коваль' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  ownerLastName!: string;

  // First branch
  @ApiProperty({ example: 'Головна філія' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  branchName!: string;

  @ApiProperty({ example: 'вул. Гагаріна 12, Київ' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  branchAddress!: string;

  // First warehouse
  @ApiPropertyOptional({ example: 'Основний склад' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  warehouseName?: string;
}

export class SetupInitResponseDto {
  @ApiProperty() orgId!: string;
  @ApiProperty() branchId!: string;
  @ApiProperty() warehouseId!: string;
  @ApiProperty() employeeId!: string;
  @ApiProperty() accessToken!: string;
}
