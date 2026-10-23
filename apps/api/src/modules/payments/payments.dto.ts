import {
  IsUUID,
  IsOptional,
  IsNumber,
  Min,
  Max,
  IsString,
  IsNotEmpty,
  IsIn,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentSourceType } from '@prisma/client';
import { MONEY_AMOUNT_MAX } from '@sto/shared';
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
  // Стеля — місткість Decimal(12,2): більша сума давала 500 `numeric field overflow` (Bug #846).
  @ApiProperty() @IsNumber() @Min(0.01) @Max(MONEY_AMOUNT_MAX) amount!: number;
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

/**
 * Query `GET /payments`. До 2026-10-24 параметри йшли без DTO: `?method=a&method=b` (масив) ставав
 * `where.method = [...]`, і Prisma відповідала 500. Тепер кожен — рядок (масив → 400), `method` —
 * код способу оплати (`PaymentMethodConfig.code`, довільний рядок організації) до 64 символів.
 */
export class PaymentsListQueryDto {
  @ApiPropertyOptional({ description: 'Сторінка (з 1)' })
  @IsOptional()
  @IsString()
  page?: string;

  @ApiPropertyOptional({ description: 'Рядків на сторінку (сервіс обмежує)' })
  @IsOptional()
  @IsString()
  limit?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  counterpartyId?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD, київська доба' })
  @IsOptional()
  @IsString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD, київська доба' })
  @IsOptional()
  @IsString()
  dateTo?: string;

  @ApiPropertyOptional({ description: 'Код способу оплати (PaymentMethodConfig.code)' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  method?: string;

  @ApiPropertyOptional({ description: "Статус фіскалізації або 'none'" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  fiscalStatus?: string;

  @ApiPropertyOptional({ description: 'Клієнт, номер рахунку, номер наряду або примітка' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
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
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Коли оплату сторновано — з каси чи безготівково (ISO); null — не сторновано (BR-CASH-024, BR-PAY-024)',
  })
  reversedAt?: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Рядок каси-сторно; null — безготівкове сторно (BR-PAY-024) або не сторновано',
  })
  reversalCashOperationId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Причина сторно (BR-PAY-024)' })
  reversalReason?: string | null;
  @ApiProperty() createdAt!: string;
}

/** Тіло `POST /payments/:id/reverse` (BR-PAY-024) — для Swagger; валідує `paymentReversalSchema`. */
export class PaymentReversalDto {
  @ApiProperty({ description: 'Причина сторно — обов’язкова, до 500 символів', maxLength: 500 })
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class PaginatedPaymentsDto {
  @ApiProperty({ type: [PaymentResponseDto] }) items!: PaymentResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
