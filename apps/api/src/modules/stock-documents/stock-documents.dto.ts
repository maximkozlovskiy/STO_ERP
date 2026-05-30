import {
  IsUUID,
  IsString,
  IsOptional,
  IsNumber,
  Min,
  IsArray,
  ValidateNested,
  IsEnum,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class StockDocumentLineDto {
  @ApiProperty()
  @IsUUID()
  goodId!: string;
  @ApiProperty() @IsNumber() @Min(0.001) quantity!: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) price?: number;
}

export class CreateStockDocumentDto {
  @ApiProperty({ enum: ['WRITEOFF', 'TRANSFER', 'OPENING_BALANCE'] })
  @IsEnum(['WRITEOFF', 'TRANSFER', 'OPENING_BALANCE'])
  type!: string;

  @ApiProperty()
  @IsUUID()
  branchId!: string;
  @ApiProperty()
  @IsUUID()
  warehouseId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  targetWarehouseId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ type: [StockDocumentLineDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StockDocumentLineDto)
  lines?: StockDocumentLineDto[];
}

export class UpdateStockDocumentDto {
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ type: [StockDocumentLineDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StockDocumentLineDto)
  lines?: StockDocumentLineDto[];
}

const DOC_TRANSITION_STATUSES = ['CONFIRMED', 'CANCELLED'] as const;
export type DocTransitionStatus = (typeof DOC_TRANSITION_STATUSES)[number];

export class TransitionStockDocumentDto {
  @ApiProperty({ enum: DOC_TRANSITION_STATUSES })
  @IsEnum(DOC_TRANSITION_STATUSES)
  status!: DocTransitionStatus;
}

export class StockDocumentLineResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() goodId!: string;
  @ApiPropertyOptional() goodName?: string;
  @ApiPropertyOptional() goodSku?: string | null;
  @ApiPropertyOptional() unit?: string;
  @ApiProperty() quantity!: number;
  @ApiPropertyOptional() price?: number | null;
}

export class StockDocumentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() number!: string;
  @ApiProperty() type!: string;
  @ApiProperty() status!: string;
  @ApiProperty() branchId!: string;
  @ApiPropertyOptional() branchName?: string;
  @ApiProperty() warehouseId!: string;
  @ApiPropertyOptional() warehouseName?: string;
  @ApiPropertyOptional() targetWarehouseId?: string | null;
  @ApiPropertyOptional() targetWarehouseName?: string | null;
  @ApiPropertyOptional() notes?: string | null;
  @ApiPropertyOptional() confirmedAt?: Date | null;
  @ApiProperty({ type: [StockDocumentLineResponseDto] }) lines!: StockDocumentLineResponseDto[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class PaginatedStockDocumentsDto {
  @ApiProperty({ type: [StockDocumentResponseDto] }) items!: StockDocumentResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
