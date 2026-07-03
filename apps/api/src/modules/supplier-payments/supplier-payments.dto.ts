import {
  IsUUID,
  IsString,
  IsOptional,
  IsNumber,
  Min,
  IsDateString,
  IsBooleanString,
  IsEnum,
  IsNumberString,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupplierPaymentStatus, PaymentSourceType } from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

export class CreateSupplierPaymentDto {
  @ApiProperty()
  @IsUUID()
  supplierId!: string;

  @ApiProperty({ enum: PaymentSourceType })
  @IsEnum(PaymentSourceType)
  sourceType!: PaymentSourceType;

  @ApiPropertyOptional({ description: 'Банківський рахунок (якщо sourceType = BANK_ACCOUNT)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  bankAccountId?: string;

  @ApiPropertyOptional({ description: 'Каса (якщо sourceType = CASH_REGISTER)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  cashRegisterId?: string;

  @ApiPropertyOptional({ description: 'Опціональна прив’язка до замовлення постачальнику' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  purchaseOrderId?: string;

  @ApiProperty()
  @IsNumber()
  @Min(0.01, { message: 'Сума оплати повинна бути більшою за нуль' })
  amount!: number;

  @ApiProperty({ description: 'Метод оплати (код з PaymentMethodConfig)' })
  @IsString()
  method!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ description: 'Дата документа (YYYY-MM-DD), за замовчуванням — сьогодні' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  documentDate?: string;
}

export class UpdateSupplierPaymentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional({ enum: PaymentSourceType })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(PaymentSourceType)
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

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  purchaseOrderId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0.01, { message: 'Сума оплати повинна бути більшою за нуль' })
  amount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  method?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ description: 'Дата документа (YYYY-MM-DD)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  documentDate?: string;
}

export class SupplierPaymentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() number!: string;
  @ApiProperty({ enum: SupplierPaymentStatus }) status!: SupplierPaymentStatus;
  @ApiProperty() supplierId!: string;
  @ApiPropertyOptional() supplierName?: string;
  @ApiProperty({ enum: PaymentSourceType }) sourceType!: PaymentSourceType;
  @ApiPropertyOptional() bankAccountId?: string | null;
  @ApiPropertyOptional() cashRegisterId?: string | null;
  @ApiPropertyOptional() sourceName?: string | null;
  @ApiPropertyOptional() purchaseOrderId?: string | null;
  @ApiPropertyOptional() purchaseOrderNumber?: string | null;
  @ApiProperty() amount!: number;
  @ApiProperty() method!: string;
  @ApiPropertyOptional() notes?: string | null;
  @ApiPropertyOptional() documentDate?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional() deletedAt?: string | null;
}

export class PaginatedSupplierPaymentsDto {
  @ApiProperty({ type: [SupplierPaymentResponseDto] }) items!: SupplierPaymentResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

export class SupplierPaymentQueryDto {
  @ApiPropertyOptional({ enum: SupplierPaymentStatus })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(SupplierPaymentStatus)
  status?: SupplierPaymentStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsString()
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsBooleanString()
  showDeleted?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsNumberString()
  page?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsNumberString()
  limit?: string;
}
