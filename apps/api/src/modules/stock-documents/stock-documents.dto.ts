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
  IsEnum,
  ArrayMaxSize,
  IsDateString,
  IsBooleanString,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StockDocumentType } from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

export class StockDocumentLineDto {
  @ApiProperty()
  @IsUUID()
  goodId!: string;
  @ApiProperty() @IsNumber() @Min(0.001) quantity!: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) price?: number;
}

export class CreateStockDocumentDto {
  @ApiProperty({ enum: StockDocumentType })
  @IsEnum(StockDocumentType)
  type!: StockDocumentType;

  @ApiProperty()
  @IsUUID()
  branchId!: string;
  @ApiProperty()
  @IsUUID()
  warehouseId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  targetWarehouseId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ description: 'Дата документа (YYYY-MM-DD), за замовчуванням — сьогодні' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  documentDate?: string;

  @ApiPropertyOptional({ type: [StockDocumentLineDto] })
  @IsOptional()
  @IsArray()
  // Bug #248: anti-DoS cap.
  @ArrayMaxSize(500, { message: 'Не більше 500 рядків у документі обліку' })
  @ValidateNested({ each: true })
  @Type(() => StockDocumentLineDto)
  lines?: StockDocumentLineDto[];
}

export class UpdateStockDocumentDto {
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;

  @ApiPropertyOptional({ description: 'Дата документа (YYYY-MM-DD)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  documentDate?: string;

  @ApiPropertyOptional({ type: [StockDocumentLineDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500, { message: 'Не більше 500 рядків у документі обліку' })
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
  @ApiPropertyOptional() unitShortName?: string;
  @ApiPropertyOptional() coefficient?: number;
  @ApiProperty() quantity!: number;
  @ApiPropertyOptional() price?: number | null;
  @ApiPropertyOptional() unitOfMeasureId?: string | null;
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
  @ApiPropertyOptional() confirmedAt?: string | null;
  @ApiPropertyOptional({ description: 'Дата документа' }) documentDate?: string | null;
  @ApiProperty({ type: [StockDocumentLineResponseDto] }) lines!: StockDocumentLineResponseDto[];
  @ApiPropertyOptional({
    description: 'Кількість позицій (для списку — заповнено замість lines.length)',
  })
  linesCount?: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional({ description: 'Set when the document is soft-deleted' })
  deletedAt?: string | null;
}

export class PaginatedStockDocumentsDto {
  @ApiProperty({ type: [StockDocumentResponseDto] }) items!: StockDocumentResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

export class StockDocumentQueryDto {
  @ApiPropertyOptional({ enum: StockDocumentType })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(StockDocumentType)
  type?: StockDocumentType;

  @ApiPropertyOptional({ enum: ['DRAFT', 'CONFIRMED', 'CANCELLED'] })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(['DRAFT', 'CONFIRMED', 'CANCELLED'])
  status?: string;

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

  @ApiPropertyOptional({ description: 'Поле сортування', enum: ['documentDate', 'createdAt'] })
  @IsOptional()
  @IsIn(['documentDate', 'createdAt'])
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
