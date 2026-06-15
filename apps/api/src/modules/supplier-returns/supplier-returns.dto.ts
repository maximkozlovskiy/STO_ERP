import {
  IsUUID,
  IsString,
  IsOptional,
  IsNumber,
  Min,
  IsArray,
  ValidateNested,
  ArrayMaxSize,
  IsDateString,
  IsBooleanString,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupplierReturnStatus } from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

export class SupplierReturnLineDto {
  @ApiProperty()
  @IsUUID()
  goodId!: string;
  @ApiProperty() @IsNumber() @Min(0.001) quantity!: number;
  @ApiProperty() @IsNumber() @Min(0) price!: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  unitOfMeasureId?: string;
}

export class CreateSupplierReturnDto {
  @ApiProperty()
  @IsUUID()
  supplierId!: string;

  @ApiProperty()
  @IsUUID()
  warehouseId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ description: 'Дата документа (YYYY-MM-DD), за замовчуванням — сьогодні' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  documentDate?: string;

  @ApiPropertyOptional({ type: [SupplierReturnLineDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500, { message: 'Не більше 500 рядків у поверненні' })
  @ValidateNested({ each: true })
  @Type(() => SupplierReturnLineDto)
  lines?: SupplierReturnLineDto[];
}

export class UpdateSupplierReturnDto {
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ description: 'Дата документа (YYYY-MM-DD)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString()
  documentDate?: string;

  @ApiPropertyOptional({ type: [SupplierReturnLineDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500, { message: 'Не більше 500 рядків у поверненні' })
  @ValidateNested({ each: true })
  @Type(() => SupplierReturnLineDto)
  lines?: SupplierReturnLineDto[];
}

export class SupplierReturnLineResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() goodId!: string;
  @ApiPropertyOptional() goodName?: string;
  @ApiPropertyOptional() goodSku?: string | null;
  @ApiPropertyOptional() unit?: string;
  @ApiPropertyOptional() unitShortName?: string;
  @ApiProperty() quantity!: number;
  @ApiProperty() price!: number;
  @ApiProperty() amount!: number;
  @ApiPropertyOptional() unitOfMeasureId?: string | null;
}

export class SupplierReturnResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiProperty() number!: string;
  @ApiProperty({ enum: SupplierReturnStatus }) status!: SupplierReturnStatus;
  @ApiProperty() supplierId!: string;
  @ApiPropertyOptional() supplierName?: string;
  @ApiProperty() warehouseId!: string;
  @ApiPropertyOptional() warehouseName?: string;
  @ApiProperty() totalAmount!: number;
  @ApiPropertyOptional() notes?: string | null;
  @ApiPropertyOptional() documentDate?: string | null;
  @ApiProperty() linesCount!: number;
  @ApiProperty({ type: [SupplierReturnLineResponseDto] }) lines!: SupplierReturnLineResponseDto[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
  @ApiPropertyOptional() deletedAt?: Date | null;
}

export class PaginatedSupplierReturnsDto {
  @ApiProperty({ type: [SupplierReturnResponseDto] }) items!: SupplierReturnResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

export class SupplierReturnQueryDto {
  @ApiPropertyOptional({ enum: SupplierReturnStatus })
  @IsOptional()
  @Transform(emptyToUndefined)
  status?: string;

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
  page?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  limit?: string;
}
