import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class SetupInitDto {
  // Organisation
  @ApiProperty({ example: 'СТО Авто-Майстер' })
  @IsString()
  orgName!: string;

  @ApiPropertyOptional({ example: '12345678' })
  @IsOptional()
  @IsString()
  edrpou?: string;

  // Owner account
  @ApiProperty({ example: 'owner@sto.local' })
  @IsEmail({}, { message: 'Невірний формат email' })
  ownerEmail!: string;

  @ApiProperty({ example: 'secret', minLength: 6 })
  @IsString()
  @MinLength(6, { message: 'Пароль має бути не менше 6 символів' })
  ownerPassword!: string;

  @ApiProperty({ example: 'Іван' })
  @IsString()
  ownerFirstName!: string;

  @ApiProperty({ example: 'Коваль' })
  @IsString()
  ownerLastName!: string;

  // First branch
  @ApiProperty({ example: 'Головна філія' })
  @IsString()
  branchName!: string;

  @ApiProperty({ example: 'вул. Гагаріна 12, Київ' })
  @IsString()
  branchAddress!: string;

  // First warehouse
  @ApiPropertyOptional({ example: 'Основний склад' })
  @IsOptional()
  @IsString()
  warehouseName?: string;
}

export class SetupInitResponseDto {
  @ApiProperty() orgId!: string;
  @ApiProperty() branchId!: string;
  @ApiProperty() warehouseId!: string;
  @ApiProperty() employeeId!: string;
  @ApiProperty() accessToken!: string;
}
