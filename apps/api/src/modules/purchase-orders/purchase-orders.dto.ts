import { IsUUID, Matches, IsString, IsOptional, IsNumber, Min, IsArray, ValidateNested, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { PurchaseOrderStatus } from '@prisma/client';

export class TransitionPurchaseOrderDto {
  @ApiProperty({ enum: PurchaseOrderStatus })
  @IsEnum(PurchaseOrderStatus)
  status!: PurchaseOrderStatus;
}

export class PurchaseOrderLineDto {
  @ApiProperty() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) goodId!: string;
  @ApiProperty() @IsNumber() @Min(0.001) quantity!: number;
  @ApiProperty() @IsNumber() @Min(0) price!: number;
}

export class CreatePurchaseOrderDto {
  @ApiProperty() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) supplierId!: string;
  @ApiProperty() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) warehouseId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ type: [PurchaseOrderLineDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineDto)
  lines?: PurchaseOrderLineDto[];
}

export class UpdatePurchaseOrderDto {
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ type: [PurchaseOrderLineDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineDto)
  lines?: PurchaseOrderLineDto[];
}

export class ReceiveLineDto {
  @ApiProperty() @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) lineId!: string;
  @ApiProperty() @IsNumber() @Min(0) receivedQty!: number;
}

export class ReceivePurchaseOrderDto {
  @ApiProperty({ type: [ReceiveLineDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReceiveLineDto)
  lines!: ReceiveLineDto[];
}

export class PurchaseOrderLineResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() goodId!: string;
  @ApiPropertyOptional() goodName?: string;
  @ApiPropertyOptional() goodSku?: string | null;
  @ApiPropertyOptional() unit?: string;
  @ApiProperty() quantity!: number;
  @ApiProperty() price!: number;
  @ApiProperty() amount!: number;
  @ApiProperty() receivedQty!: number;
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
  @ApiProperty() totalAmount!: number;
  @ApiPropertyOptional() notes?: string | null;
  @ApiProperty() linesCount!: number;
  @ApiProperty({ type: [PurchaseOrderLineResponseDto] }) lines!: PurchaseOrderLineResponseDto[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class PaginatedPurchaseOrdersDto {
  @ApiProperty({ type: [PurchaseOrderResponseDto] }) items!: PurchaseOrderResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
