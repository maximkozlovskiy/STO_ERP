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

// ─── Counterparty ────────────────────────────────────────

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
    description: 'Поле сортування',
    enum: ['lastName', 'createdAt', 'balance'],
  })
  @IsOptional()
  @IsIn(['lastName', 'createdAt', 'balance'])
  sortBy?: string;

  @ApiPropertyOptional({ description: 'Напрям сортування', enum: ['asc', 'desc'] })
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
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiPropertyOptional({ description: 'Set when soft-deleted (showDeleted=true)' })
  deletedAt?: Date | null;
}

export class PaginatedCounterpartiesDto {
  @ApiProperty({ type: [CounterpartyResponseDto] }) items!: CounterpartyResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

// ─── CustomerGarage ──────────────────────────────────────

export class CreateGarageDto {
  @ApiProperty() @IsString() @IsNotEmpty() name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
}

export class GarageResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() counterpartyId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() address?: string | null;
  @ApiPropertyOptional() notes?: string | null;
  @ApiProperty() isDefault!: boolean;
  @ApiProperty() createdAt!: Date;
}

// ─── CounterpartyContract ─────────────────────────────────

export class CreateContractDto {
  // Bug #353: @MaxLength anti-DoS — номер документа має реалістичний верхній ліміт.
  @ApiPropertyOptional({ description: 'Номер договору (авто якщо не передано)' })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: 'Номер договору не може перевищувати 50 символів' })
  number?: string;

  @ApiProperty({ enum: ContractType })
  @IsEnum(ContractType)
  contractType!: ContractType;

  @ApiProperty({ description: 'Дата початку (YYYY-MM-DD)' })
  @IsDateString()
  startDate!: string;

  @ApiPropertyOptional({ description: 'Дата завершення (YYYY-MM-DD)' })
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

  @ApiPropertyOptional({ description: 'ISO код валюти (напр. UAH, USD, EUR)' })
  @IsOptional()
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
  // Bug #353: @MaxLength anti-DoS — номер документа має реалістичний верхній ліміт.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: 'Номер договору не може перевищувати 50 символів' })
  number?: string;

  @ApiPropertyOptional({ enum: ContractType })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(ContractType)
  contractType?: ContractType;

  @ApiPropertyOptional({ description: 'Дата початку (YYYY-MM-DD)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Дата завершення (YYYY-MM-DD)' })
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

  @ApiPropertyOptional({ description: 'ISO код валюти (напр. UAH, USD, EUR)' })
  @IsOptional()
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
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiPropertyOptional() deletedAt!: Date | null;
}
