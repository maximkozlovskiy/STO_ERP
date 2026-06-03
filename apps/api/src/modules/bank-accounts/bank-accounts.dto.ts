import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { IBAN_UA_REGEX } from '@sto/shared';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

export class CreateBankAccountDto {
  @ApiProperty({ example: 'Поточний рахунок ПриватБанк' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({
    example: 'UA213223130000026007233566001',
    description: '2 літери + 27 цифр (29 символів)',
  })
  @Matches(IBAN_UA_REGEX, {
    message: 'Невірний формат IBAN. Має починатись з UA та містити 29 символів',
  })
  ibanUA!: string;

  @ApiProperty({ example: 'uuid' })
  @IsUUID()
  @IsNotEmpty()
  currencyId!: string;

  @ApiPropertyOptional({ example: 'ПриватБанк' })
  @IsOptional()
  @IsString()
  bankName?: string;

  @ApiPropertyOptional({ example: 'uuid' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({ example: '305299' })
  @IsOptional()
  @IsString()
  mfo?: string;

  @ApiPropertyOptional({ example: '12345678' })
  @IsOptional()
  @IsString()
  edrpou?: string;

  @ApiPropertyOptional({ example: 'м. Київ, вул. Грушевського, 1' })
  @IsOptional()
  @IsString()
  bankAddress?: string;
}

export class UpdateBankAccountDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(IBAN_UA_REGEX, {
    message: 'Невірний формат IBAN. Має починатись з UA та містити 29 символів',
  })
  ibanUA?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  currencyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bankName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  branchId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  mfo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  edrpou?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bankAddress?: string;
}

export class BankAccountResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() ibanUA!: string;
  @ApiProperty() currencyId!: string;
  @ApiProperty() currencyCode!: string;
  @ApiPropertyOptional() bankName?: string | null;
  @ApiPropertyOptional() branchId?: string | null;
  @ApiPropertyOptional() branchName?: string | null;
  @ApiPropertyOptional() mfo?: string | null;
  @ApiPropertyOptional() edrpou?: string | null;
  @ApiPropertyOptional() bankAddress?: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
