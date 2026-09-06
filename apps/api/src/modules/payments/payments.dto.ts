import { IsUUID, IsOptional, IsNumber, Min, IsString, IsNotEmpty, IsIn } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentSourceType } from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

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
}

export class PaymentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() counterpartyId!: string;
  @ApiPropertyOptional() counterpartyName?: string;
  @ApiPropertyOptional() workOrderId?: string | null;
  @ApiPropertyOptional() invoiceId?: string | null;
  @ApiProperty() amount!: number;
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
