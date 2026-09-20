import { IsUUID, IsOptional, IsNumber, Min, IsString, IsNotEmpty, IsIn } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentSourceType, SettlementTransactionType } from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

// Тип проводки балансу для вхідного платежу. Дефолт PAYMENT (звичайна оплата — знак −1).
// Bank-statement рознесення передає PREPAYMENT (аванс) або REFUND (повернення). Клієнтські типи лише.
export const PAYMENT_SETTLEMENT_TYPES = ['PAYMENT', 'PREPAYMENT', 'REFUND'] as const;
export type PaymentSettlementType = (typeof PAYMENT_SETTLEMENT_TYPES)[number];

export class CreatePaymentDto {
  @ApiProperty()
  @IsUUID()
  counterpartyId!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  workOrderId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  invoiceId?: string;
  @ApiProperty() @IsNumber() @Min(0.01) amount!: number;
  @ApiProperty() @IsString() @IsNotEmpty() method!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  // Рахунок-призначення (опц.): куди фізично лягли гроші. Якщо не задано — дефолт з methodConfig.
  @ApiPropertyOptional({ enum: PaymentSourceType })
  @IsOptional()
  @IsIn(Object.values(PaymentSourceType))
  sourceType?: PaymentSourceType;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  bankAccountId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  cashRegisterId?: string;
  // Внутрішнє: лінк на онлайн-намір (QR monobank). @unique у БД → idempotency-guard проти дубля
  // Payment під час реконсиляції наміру (Bug #688). Не для публічного вводу (касир не задає).
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  onlinePaymentIntentId?: string;
  // Внутрішнє: тип проводки балансу (дефолт PAYMENT). Bank-statement рознесення передає PREPAYMENT/
  // REFUND. Не для публічного вводу — касир завжди PAYMENT. append-only-safe (default зберігає поведінку).
  @ApiPropertyOptional({ enum: PAYMENT_SETTLEMENT_TYPES })
  @IsOptional()
  @IsIn(PAYMENT_SETTLEMENT_TYPES)
  settlementType?: PaymentSettlementType;
}

export class PaymentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() counterpartyId!: string;
  @ApiPropertyOptional() counterpartyName?: string;
  @ApiPropertyOptional() workOrderId?: string | null;
  @ApiPropertyOptional() invoiceId?: string | null;
  @ApiProperty() amount!: number;
  // Мультивалюта (Фаза 2): валюта оплати + base-сума по курсу на дату. null → історичні/UAH.
  @ApiPropertyOptional() currencyId?: string | null;
  @ApiPropertyOptional() currencyCode?: string | null;
  @ApiPropertyOptional() amountBase?: number | null;
  @ApiPropertyOptional() rateUsed?: number | null;
  @ApiProperty() method!: string;
  @ApiPropertyOptional() notes?: string | null;
  @ApiPropertyOptional() fiscalReceiptId?: string | null;
  @ApiPropertyOptional() fiscalStatus?: string | null;
  @ApiPropertyOptional() fiscalError?: string | null;
  @ApiPropertyOptional() sourceType?: string | null;
  @ApiPropertyOptional() bankAccountId?: string | null;
  @ApiPropertyOptional() cashRegisterId?: string | null;
  @ApiPropertyOptional() sourceName?: string | null;
  @ApiProperty() createdAt!: string;
}

export class PaginatedPaymentsDto {
  @ApiProperty({ type: [PaymentResponseDto] }) items!: PaymentResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
