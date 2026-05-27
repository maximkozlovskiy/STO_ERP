import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Min, Max, IsArray, ArrayMaxSize } from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { CounterpartyType, LegalForm } from '@prisma/client';

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
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional({ enum: LegalForm }) @IsOptional() @IsEnum(LegalForm) legalForm?: LegalForm;
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
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional({ enum: LegalForm }) @IsOptional() @IsEnum(LegalForm) legalForm?: LegalForm;
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
    const arr = Array.isArray(value) ? value : String(value).split(',').map(s => s.trim());
    return arr.filter(Boolean);
  })
  @IsArray()
  @IsEnum(CounterpartyType, { each: true })
  @ArrayMaxSize(10)
  types?: CounterpartyType[];

  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit: number = 20;
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
