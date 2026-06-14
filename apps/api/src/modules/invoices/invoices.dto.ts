import {
  IsUUID,
  IsOptional,
  IsIn,
  IsNumber,
  Min,
  Max,
  IsString,
  IsDateString,
  IsEnum,
  IsBooleanString,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InvoiceStatus } from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

export class CreateInvoiceDto {
  @ApiProperty()
  @IsUUID()
  counterpartyId!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  workOrderId?: string;
  @ApiProperty() @IsNumber() @Min(0.01) amount!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() invoiceType?: string;
  // Bug #260: emptyToUndefined gap — date-input скидання → 400 без трансформу.
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  dueDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ description: 'Дата документа (YYYY-MM-DD), за замовчуванням — сьогодні' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  documentDate?: string;
}

export class UpdateInvoiceDto {
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0.01) amount?: number;
  // Bug #260: emptyToUndefined gap у PATCH-шляху.
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  dueDate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ description: 'Дата документа (YYYY-MM-DD)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  documentDate?: string;
}

const INV_TRANSITION_STATUSES = ['SENT', 'PAID', 'CANCELLED'] as const;
export type InvTransitionStatus = (typeof INV_TRANSITION_STATUSES)[number];

export class TransitionInvoiceDto {
  @ApiProperty({ enum: INV_TRANSITION_STATUSES })
  @IsEnum(INV_TRANSITION_STATUSES)
  status!: InvTransitionStatus;
}

export class CreateInvoiceLineDto {
  @ApiProperty() @IsString() description!: string;
  @ApiProperty() @IsNumber() @Min(0.001) quantity!: number;
  @ApiProperty() @IsNumber() @Min(0) unitPrice!: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Max(100) vatRate?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  goodId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  workId?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) sortOrder?: number;
  @ApiPropertyOptional({ description: 'ID одиниці виміру з GoodUoM товару' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  unitOfMeasureId?: string;
}

export class UpdateInvoiceLineDto {
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0.001) quantity?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) unitPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Max(100) vatRate?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) sortOrder?: number;
  @ApiPropertyOptional({ description: 'ID одиниці виміру з GoodUoM товару' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  unitOfMeasureId?: string;
}

export class InvoiceLineResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() invoiceId!: string;
  @ApiPropertyOptional() goodId?: string | null;
  @ApiPropertyOptional() workId?: string | null;
  @ApiProperty() description!: string;
  @ApiPropertyOptional() unitOfMeasureId?: string | null;
  @ApiPropertyOptional() unitShortName?: string;
  @ApiPropertyOptional() coefficient?: number;
  @ApiProperty() quantity!: number;
  @ApiProperty() unitPrice!: number;
  @ApiProperty() vatRate!: number;
  @ApiProperty() priceWithoutVat!: number;
  @ApiProperty() vatAmount!: number;
  @ApiProperty() priceWithVat!: number;
  @ApiProperty() sortOrder!: number;
  @ApiProperty() createdAt!: Date;
}

export class InvoiceResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() number!: string;
  @ApiProperty({ enum: InvoiceStatus }) status!: InvoiceStatus;
  @ApiProperty() counterpartyId!: string;
  @ApiPropertyOptional() counterpartyName?: string;
  @ApiPropertyOptional() workOrderId?: string | null;
  @ApiPropertyOptional() workOrderNumber?: string | null;
  @ApiProperty() amount!: number;
  @ApiProperty() totalWithoutVat!: number;
  @ApiProperty() totalVat!: number;
  @ApiProperty() totalWithVat!: number;
  @ApiPropertyOptional() invoiceType?: string;
  @ApiPropertyOptional() notes?: string | null;
  @ApiPropertyOptional() dueDate?: Date | null;
  @ApiPropertyOptional({ description: 'Дата документа' }) documentDate?: string | null;
  @ApiPropertyOptional() paidAmount?: number;
  @ApiPropertyOptional({ type: [InvoiceLineResponseDto] }) lines?: InvoiceLineResponseDto[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiPropertyOptional({ description: 'Set when the invoice is soft-deleted' })
  deletedAt?: Date | null;
}

export class PaginatedInvoicesDto {
  @ApiProperty({ type: [InvoiceResponseDto] }) items!: InvoiceResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

export class InvoiceQueryDto {
  @ApiPropertyOptional({ enum: InvoiceStatus })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(InvoiceStatus)
  status?: InvoiceStatus;

  @ApiPropertyOptional() @IsOptional() @IsString() q?: string;

  @ApiPropertyOptional({ description: 'Показати видалені' })
  @IsOptional()
  @IsBooleanString()
  showDeleted?: string;

  @ApiPropertyOptional({ description: 'Дата документа від (YYYY-MM-DD)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Дата документа до (YYYY-MM-DD)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({
    description: 'Поле сортування',
    enum: ['documentDate', 'createdAt', 'dueDate', 'amount'],
  })
  @IsOptional()
  @IsIn(['documentDate', 'createdAt', 'dueDate', 'amount'])
  sortBy?: string;

  @ApiPropertyOptional({ description: 'Напрям сортування', enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(200)
  limit: number = 20;
}
