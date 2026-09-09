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

  @ApiProperty({ example: 'secret12', minLength: 8 })
  @IsString()
  @IsNotEmpty({ message: 'Пароль не може бути порожнім' })
  // B2 password policy: мінімум 8 символів для нового власника (початкове налаштування org —
  // legacy-акаунтів немає, тому підняття порогу нікого не блокує; узгоджено з change-password).
  @MinLength(8, { message: 'Пароль має бути не менше 8 символів' })
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
