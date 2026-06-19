import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  Max,
  MaxLength,
  IsArray,
  ArrayMaxSize,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ContractType, CounterpartyType, LegalForm } from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';
import { toUpperCurrencyCode } from '../../common/transforms/to-upper-currency-code';

// в”Ђв”Ђв”Ђ Counterparty в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

export class CreateCounterpartyDto {
  @ApiProperty({ enum: CounterpartyType })
  @IsEnum(CounterpartyType)
  type!: CounterpartyType;

  @ApiPropertyOptional() @IsOptional() @IsString() firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() companyName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() edrpou?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() vatPayer?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToUndefined) @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional({ enum: LegalForm })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(LegalForm)
  legalForm?: LegalForm;
  @ApiPropertyOptional() @IsOptional() @IsString() legalAddress?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() actualAddress?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() bankAccount?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() bankName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() contactPerson?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() taxNumber?: string;
}

export class UpdateCounterpartyDto {
  @ApiPropertyOptional() @IsOptional() @IsString() firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() lastName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() companyName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() edrpou?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() vatPayer?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToUndefined) @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional({ enum: LegalForm })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(LegalForm)
  legalForm?: LegalForm;
  @ApiPropertyOptional() @IsOptional() @IsString() legalAddress?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() actualAddress?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() bankAccount?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() bankName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() contactPerson?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() taxNumber?: string;
}

export class CounterpartyQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() q?: string;

  @ApiPropertyOptional({ enum: CounterpartyType })
  @IsOptional()
  @IsEnum(CounterpartyType)
  type?: CounterpartyType;

  // Multi-type filter: ?types=SUPPLIER,BOTH  or  ?types[]=SUPPLIER&types[]=BOTH
  @ApiPropertyOptional({ enum: CounterpartyType, isArray: true })
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return undefined;
    // Accept comma-separated string OR array
    const arr = Array.isArray(value)
      ? value
      : String(value)
          .split(',')
          .map(s => s.trim());
    return arr.filter(Boolean);
  })
  @IsArray()
  @IsEnum(CounterpartyType, { each: true })
  @ArrayMaxSize(10)
  types?: CounterpartyType[];

  @ApiPropertyOptional({ description: 'Include soft-deleted counterparties' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  showDeleted?: boolean;

  @ApiPropertyOptional({
    description: 'РџРѕР»Рµ СЃРѕСЂС‚СѓРІР°РЅРЅСЏ',
    enum: ['lastName', 'createdAt', 'balance'],
  })
  @IsOptional()
  @IsIn(['lastName', 'createdAt', 'balance'])
  sortBy?: string;

  @ApiPropertyOptional({ description: 'РќР°РїСЂСЏРј СЃРѕСЂС‚СѓРІР°РЅРЅСЏ', enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;
  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 20;
}

export class CounterpartyResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty({ enum: CounterpartyType }) type!: CounterpartyType;
  @ApiPropertyOptional() firstName?: string | null;
  @ApiPropertyOptional() lastName?: string | null;
  @ApiPropertyOptional() companyName?: string | null;
  @ApiPropertyOptional() edrpou?: string | null;
  @ApiProperty() vatPayer!: boolean;
  @ApiPropertyOptional() phone?: string | null;
  @ApiPropertyOptional() email?: string | null;
  @ApiPropertyOptional() notes?: string | null;
  @ApiPropertyOptional({ enum: LegalForm }) legalForm?: LegalForm | null;
  @ApiPropertyOptional() legalAddress?: string | null;
  @ApiPropertyOptional() actualAddress?: string | null;
  @ApiPropertyOptional() bankAccount?: string | null;
  @ApiPropertyOptional() bankName?: string | null;
  @ApiPropertyOptional() contactPerson?: string | null;
  @ApiPropertyOptional() taxNumber?: string | null;
  @ApiPropertyOptional() balance?: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional({ description: 'Set when soft-deleted (showDeleted=true)' })
  deletedAt?: string | null;
}

export class PaginatedCounterpartiesDto {
  @ApiProperty({ type: [CounterpartyResponseDto] }) items!: CounterpartyResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

// в”Ђв”Ђв”Ђ CustomerGarage в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

export class CreateGarageDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(200) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class GarageResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() counterpartyId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() address?: string | null;
  @ApiPropertyOptional() notes?: string | null;
  @ApiProperty() isDefault!: boolean;
  @ApiProperty() createdAt!: string;
}

// в”Ђв”Ђв”Ђ CounterpartyContract в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

export class CreateContractDto {
  // Bug #353: @MaxLength anti-DoS вЂ” РЅРѕРјРµСЂ РґРѕРєСѓРјРµРЅС‚Р° РјР°С” СЂРµР°Р»С–СЃС‚РёС‡РЅРёР№ РІРµСЂС…РЅС–Р№ Р»С–РјС–С‚.
  @ApiPropertyOptional({
    description: 'РќРѕРјРµСЂ РґРѕРіРѕРІРѕСЂСѓ (Р°РІС‚Рѕ СЏРєС‰Рѕ РЅРµ РїРµСЂРµРґР°РЅРѕ)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50, {
    message:
      'РќРѕРјРµСЂ РґРѕРіРѕРІРѕСЂСѓ РЅРµ РјРѕР¶Рµ РїРµСЂРµРІРёС‰СѓРІР°С‚Рё 50 СЃРёРјРІРѕР»С–РІ',
  })
  number?: string;

  @ApiProperty({ enum: ContractType })
  @IsEnum(ContractType)
  contractType!: ContractType;

  @ApiProperty({ description: 'Р”Р°С‚Р° РїРѕС‡Р°С‚РєСѓ (YYYY-MM-DD)' })
  @IsDateString()
  startDate!: string;

  @ApiPropertyOptional({ description: 'Р”Р°С‚Р° Р·Р°РІРµСЂС€РµРЅРЅСЏ (YYYY-MM-DD)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  creditLimit?: number;

  // Bug #359: toUpperCurrencyCode РЅРѕСЂРјР°Р»С–Р·СѓС” `uah` в†’ `UAH` (Currency.code UPPERCASE
  // Сѓ DB-СЃС–РґС–, lookup case-sensitive). Replaces emptyToUndefined вЂ” С‚РѕР№ helper Р»РёС€Рµ
  // РјР°РїРёС‚СЊ '' в†’ undefined, РЅРµ upper-cases.
  @ApiPropertyOptional({ description: 'ISO РєРѕРґ РІР°Р»СЋС‚Рё (РЅР°РїСЂ. UAH, USD, EUR)' })
  @IsOptional()
  @Transform(toUpperCurrencyCode)
  @IsString()
  @MaxLength(10)
  currencyCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  paymentDeferDays?: number;
}

export class UpdateContractDto {
  // Bug #353: @MaxLength anti-DoS вЂ” РЅРѕРјРµСЂ РґРѕРєСѓРјРµРЅС‚Р° РјР°С” СЂРµР°Р»С–СЃС‚РёС‡РЅРёР№ РІРµСЂС…РЅС–Р№ Р»С–РјС–С‚.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50, {
    message:
      'РќРѕРјРµСЂ РґРѕРіРѕРІРѕСЂСѓ РЅРµ РјРѕР¶Рµ РїРµСЂРµРІРёС‰СѓРІР°С‚Рё 50 СЃРёРјРІРѕР»С–РІ',
  })
  number?: string;

  @ApiPropertyOptional({ enum: ContractType })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(ContractType)
  contractType?: ContractType;

  @ApiPropertyOptional({ description: 'Р”Р°С‚Р° РїРѕС‡Р°С‚РєСѓ (YYYY-MM-DD)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Р”Р°С‚Р° Р·Р°РІРµСЂС€РµРЅРЅСЏ (YYYY-MM-DD)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  creditLimit?: number;

  // Bug #359: toUpperCurrencyCode РЅРѕСЂРјР°Р»С–Р·СѓС” `uah` в†’ `UAH` (Currency.code UPPERCASE
  // Сѓ DB-СЃС–РґС–, lookup case-sensitive). Replaces emptyToUndefined вЂ” С‚РѕР№ helper Р»РёС€Рµ
  // РјР°РїРёС‚СЊ '' в†’ undefined, РЅРµ upper-cases.
  @ApiPropertyOptional({ description: 'ISO РєРѕРґ РІР°Р»СЋС‚Рё (РЅР°РїСЂ. UAH, USD, EUR)' })
  @IsOptional()
  @Transform(toUpperCurrencyCode)
  @IsString()
  @MaxLength(10)
  currencyCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  paymentDeferDays?: number;
}

export class ContractResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() counterpartyId!: string;
  @ApiProperty() number!: string;
  @ApiProperty({ enum: ContractType }) contractType!: ContractType;
  @ApiProperty() startDate!: string;
  @ApiPropertyOptional() endDate!: string | null;
  @ApiProperty() isPrimary!: boolean;
  @ApiPropertyOptional() creditLimit!: number | null;
  @ApiProperty() currencyCode!: string;
  @ApiPropertyOptional() paymentDeferDays!: number | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional() deletedAt!: string | null;
}
