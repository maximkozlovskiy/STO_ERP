import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { CounterpartyType } from '@prisma/client';

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
}

export class CounterpartyQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() q?: string;
  @ApiPropertyOptional({ enum: CounterpartyType }) @IsOptional() @IsEnum(CounterpartyType) type?: CounterpartyType;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @ApiPropertyOptional({ default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;
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
