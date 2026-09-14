import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

// Дзеркалить Prisma-enum (тримаємо локально, щоб DTO не залежав від @prisma/client у валідації).
export enum CashDirectionDto {
  IN = 'IN',
  OUT = 'OUT',
}
export enum CashReasonDto {
  SALE_PAYMENT = 'SALE_PAYMENT',
  REFUND = 'REFUND',
  PAYROLL = 'PAYROLL',
  SUPPLIER_PAYMENT = 'SUPPLIER_PAYMENT',
  EXPENSE = 'EXPENSE',
  COLLECTION = 'COLLECTION',
  MANUAL_IN = 'MANUAL_IN',
  MANUAL_OUT = 'MANUAL_OUT',
}

/** Ручна касова операція (внести/видати). Авто-операції (SALE_PAYMENT/PAYROLL) — з інших сервісів. */
export class CreateCashOperationDto {
  @ApiProperty({ enum: CashDirectionDto })
  @IsEnum(CashDirectionDto)
  direction!: CashDirectionDto;

  @ApiProperty({ example: 500 })
  @IsNumber()
  @IsPositive()
  amount!: number;

  @ApiProperty({ enum: CashReasonDto })
  @IsEnum(CashReasonDto)
  reason!: CashReasonDto;

  @ApiPropertyOptional({ description: 'Стаття витрат (для reason=EXPENSE)' })
  @IsOptional()
  @IsUUID()
  expenseCategoryId?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID() counterpartyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class CashOperationResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() cashRegisterId!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) cashShiftId?: string | null;
  @ApiProperty() direction!: string;
  @ApiProperty({ description: 'Сума у валюті каси' }) amount!: number;
  @ApiPropertyOptional({ description: 'Сума у базовій валюті (UAH) по курсу на дату операції' })
  amountBase?: number | null;
  @ApiPropertyOptional({ description: 'Застосований курс (base за 1 од. валюти каси)' })
  rateUsed?: number | null;
  @ApiProperty() reason!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) expenseCategoryId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) expenseCategoryName?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) counterpartyId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) employeeId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) documentType?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) documentId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) notes?: string | null;
  @ApiProperty() createdAt!: string;
}
