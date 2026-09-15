import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import type { ImportDocType } from './document-line-import.adapter';

const IMPORT_DOC_TYPES: ImportDocType[] = ['PURCHASE_ORDER', 'STOCK_DOCUMENT'];

/**
 * Multipart form-fields майстра прев'ю. Числові поля приходять рядками з form-data —
 * @Type(() => Number) коерсить. Колонки 1-based; startRow — рядок першого товару.
 */
export class PreviewImportDto {
  @ApiProperty({ enum: IMPORT_DOC_TYPES })
  @IsEnum(IMPORT_DOC_TYPES as unknown as object)
  docType!: ImportDocType;

  @ApiProperty()
  @IsUUID()
  docId!: string;

  @ApiPropertyOptional({ default: 2, description: 'Рядок першого товару (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  startRow: number = 2;

  @ApiPropertyOptional({ description: 'Колонка коду (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  codeCol?: number;

  @ApiPropertyOptional({ description: 'Колонка артикулу (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  articleCol?: number;

  @ApiPropertyOptional({ description: 'Колонка бренду (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  brandCol?: number;

  @ApiPropertyOptional({ description: 'Колонка найменування (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  nameCol?: number;

  @ApiPropertyOptional({ description: 'Колонка кількості (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantityCol?: number;

  @ApiPropertyOptional({ description: 'Колонка ціни (1-based)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  priceCol?: number;
}

export type PreviewRowStatus = 'matched' | 'ambiguous' | 'notFound';

export interface PreviewCandidate {
  id: string;
  sku: string | null;
  name: string;
  brandName: string | null;
}

export class PreviewRowDto {
  @ApiProperty() rowIndex!: number;
  @ApiPropertyOptional() rawCode?: string | null;
  @ApiPropertyOptional() rawArticle?: string | null;
  @ApiPropertyOptional() rawBrand?: string | null;
  @ApiPropertyOptional() rawName?: string | null;
  @ApiProperty() quantity!: number;
  @ApiProperty() price!: number;
  @ApiProperty({ enum: ['matched', 'ambiguous', 'notFound'] }) status!: PreviewRowStatus;
  @ApiPropertyOptional() matchedGoodId?: string | null;
  @ApiProperty({ type: 'array', items: { type: 'object' } })
  candidates!: PreviewCandidate[];
}

export class PreviewImportResponseDto {
  @ApiProperty({ type: [PreviewRowDto] }) rows!: PreviewRowDto[];
}

// ─── Apply ────────────────────────────────────────────────────────────────────

export class ApplyImportRowCreateDto {
  @ApiProperty() @IsString() name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() sku?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() rawBrand?: string;
}

export class ApplyImportRowDto {
  @ApiProperty() @IsInt() rowIndex!: number;

  @ApiProperty({ enum: ['use', 'create'] })
  @IsIn(['use', 'create'])
  action!: 'use' | 'create';

  @ApiPropertyOptional({ description: 'Обов’язковий для action=use' })
  @IsOptional()
  @IsUUID()
  goodId?: string;

  @ApiPropertyOptional({
    type: ApplyImportRowCreateDto,
    description: 'Обов’язковий для action=create',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApplyImportRowCreateDto)
  createData?: ApplyImportRowCreateDto;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  quantity!: number;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price!: number;
}

export class ApplyImportDto {
  @ApiProperty({ enum: IMPORT_DOC_TYPES })
  @IsEnum(IMPORT_DOC_TYPES as unknown as object)
  docType!: ImportDocType;

  @ApiProperty()
  @IsUUID()
  docId!: string;

  @ApiProperty({ type: [ApplyImportRowDto] })
  @IsArray()
  @ArrayMaxSize(1000, { message: 'Не більше 1000 рядків за один імпорт' })
  @ValidateNested({ each: true })
  @Type(() => ApplyImportRowDto)
  rows!: ApplyImportRowDto[];
}
