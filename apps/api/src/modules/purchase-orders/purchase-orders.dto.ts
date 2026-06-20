import {
  IsUUID,
  IsString,
  IsOptional,
  IsIn,
  IsNumber,
  Min,
  Max,
  IsArray,
  ValidateNested,
  ValidateIf,
  IsEnum,
  ArrayMaxSize,
  IsDateString,
  IsBooleanString,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PurchaseOrderStatus } from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

export class TransitionPurchaseOrderDto {
  @ApiProperty({ enum: PurchaseOrderStatus })
  @IsEnum(PurchaseOrderStatus)
  status!: PurchaseOrderStatus;
}

export class PurchaseOrderLineDto {
  @ApiProperty()
  @IsUUID()
  goodId!: string;
  @ApiProperty() @IsNumber() @Min(0.001) quantity!: number;
  @ApiProperty() @IsNumber() @Min(0) price!: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) pricedSalePrice?: number;
}

export class CreatePurchaseOrderDto {
  @ApiProperty()
  @IsUUID()
  supplierId!: string;
  @ApiProperty()
  @IsUUID()
  warehouseId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({
    description: 'Договір постачальника (PURCHASE). Авто-вибір якщо не передано.',
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  contractId?: string;

  @ApiPropertyOptional({ description: 'Дата документа (YYYY-MM-DD), за замовчуванням — сьогодні' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  documentDate?: string;

  @ApiPropertyOptional({ type: [PurchaseOrderLineDto] })
  @IsOptional()
  @IsArray()
  // Anti-DoS cap: 500 lines is an extreme upper bound for a purchase order.
  @ArrayMaxSize(500, { message: 'Не більше 500 рядків у покупковому ордері' })
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineDto)
  lines?: PurchaseOrderLineDto[];
}

export class UpdatePurchaseOrderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  warehouseId?: string;

  @ApiPropertyOptional({
    description:
      'Договір постачальника. null/"" → очистити; UUID → встановити; undefined → не чіпати',
    nullable: true,
  })
  @IsOptional()
  @Transform(emptyToUndefined)
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  contractId?: string | null;

  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ description: 'Дата документа (YYYY-MM-DD)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  documentDate?: string;

  @ApiPropertyOptional({ type: [PurchaseOrderLineDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500, { message: 'Не більше 500 рядків у покупковому ордері' })
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineDto)
  lines?: PurchaseOrderLineDto[];
}

export class ReceiveLineDto {
  @ApiProperty()
  @IsUUID()
  lineId!: string;
  @ApiProperty() @IsNumber() @Min(0) receivedQty!: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  unitOfMeasureId?: string;
}

export class ReceivePurchaseOrderDto {
  @ApiProperty({ type: [ReceiveLineDto] })
  @IsArray()
  @ArrayMaxSize(500, { message: 'Не більше 500 рядків у частковому прийнятті' })
  @ValidateNested({ each: true })
  @Type(() => ReceiveLineDto)
  lines!: ReceiveLineDto[];
}

export class PurchaseOrderLineResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() goodId!: string;
  @ApiPropertyOptional() goodName?: string;
  @ApiPropertyOptional() goodSku?: string | null;
  @ApiPropertyOptional() goodInternalCode?: string | null;
  @ApiPropertyOptional() goodBrandName?: string | null;
  @ApiPropertyOptional() unit?: string;
  @ApiPropertyOptional() unitShortName?: string;
  @ApiPropertyOptional() coefficient?: number;
  @ApiProperty() quantity!: number;
  @ApiProperty() price!: number;
  @ApiProperty() amount!: number;
  @ApiProperty() vatRate!: number;
  @ApiProperty() vatAmount!: number;
  @ApiProperty() receivedQty!: number;
  @ApiPropertyOptional() pricedSalePrice?: number | null;
  @ApiPropertyOptional() pricingRuleName?: string | null;
  @ApiPropertyOptional() unitOfMeasureId?: string | null;
}

export class PurchaseOrderResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() number!: string;
  @ApiProperty({ enum: PurchaseOrderStatus }) status!: PurchaseOrderStatus;
  @ApiPropertyOptional() supplierName?: string;
  @ApiProperty() supplierId!: string;
  @ApiProperty() warehouseId!: string;
  @ApiPropertyOptional() warehouseName?: string;
  @ApiPropertyOptional({ description: 'Договір постачальника' }) contractId?: string | null;
  @ApiPropertyOptional() contractNumber?: string | null;
  @ApiProperty() totalAmount!: number;
  @ApiProperty() totalVat!: number;
  @ApiPropertyOptional() notes?: string | null;
  @ApiPropertyOptional({ description: 'Дата документа' }) documentDate?: string | null;
  @ApiPropertyOptional({ description: 'Дата останнього розцінення' }) pricedAt?: string | null;
  @ApiProperty() linesCount!: number;
  @ApiProperty({ type: [PurchaseOrderLineResponseDto] }) lines!: PurchaseOrderLineResponseDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional({ description: 'Set when the purchase order is soft-deleted' })
  deletedAt?: string | null;
}

export class PaginatedPurchaseOrdersDto {
  @ApiProperty({ type: [PurchaseOrderResponseDto] }) items!: PurchaseOrderResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

export class PurchaseOrderQueryDto {
  @ApiPropertyOptional({ enum: PurchaseOrderStatus })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(PurchaseOrderStatus)
  status?: PurchaseOrderStatus;

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
    enum: ['documentDate', 'createdAt', 'totalAmount'],
  })
  @IsOptional()
  @IsIn(['documentDate', 'createdAt', 'totalAmount'])
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
