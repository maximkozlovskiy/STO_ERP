import {
  ArrayMaxSize,
  IsString,
  IsNotEmpty,
  IsNumber,
  IsArray,
  Matches,
  Min,
  Max,
  IsOptional,
  IsPositive,
  IsBoolean,
  IsEnum,
  IsUUID,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { StockBatchDto } from '../inventory/batch.service';
import { GoodType } from '@prisma/client';
import { UUID_REGEX } from '@sto/shared';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

export class CreateGoodDto {
  @ApiPropertyOptional() @IsOptional() @IsString() sku?: string;
  @ApiProperty() @IsString() @IsNotEmpty() name!: string;
  @ApiPropertyOptional({ default: 'шт' }) @IsOptional() @IsString() unit?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  unitId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  brandId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  purchasePrice?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  salePrice?: number;

  @ApiPropertyOptional() @IsOptional() @IsString() category?: string;
  @ApiPropertyOptional({ description: 'UUID категорії товарів (GoodCategory)' })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  goodCategoryId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() barcode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  // emptyToUndefined: UpdateGoodDto extends PartialType and inherits this transform.
  @ApiPropertyOptional({ enum: GoodType })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(GoodType)
  goodType?: GoodType;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  preferredSupplierId?: string;
}

export class UpdateGoodDto extends PartialType(CreateGoodDto) {}

// Сканер ШК часто додає провідні/кінцеві пробіли (або оператор вводить їх вручну).
// Бек шукає sub-ШК через `equals` (точний матч) — не-обрізаний " 4820…" не збіжиться,
// хоча код у БД записаний без пробілів → сканування дає порожній список і нічого не
// вибирається. Обрізаємо на рівні DTO ДО побудови where; порожнє після trim → undefined
// (щоб `?q= ` не тлумачився як фільтр за пробілом).
const trimQueryValue = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() || undefined : value;

export class GoodQueryDto {
  @ApiPropertyOptional() @IsOptional() @Transform(trimQueryValue) @IsString() q?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(trimQueryValue) @IsString() barcode?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() category?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() goodCategoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  // Anti-DoS cap: без ліміту атакувальник з JWT може POST-ити Array(1_000_000).fill(UUID)
  // → ValidationPipe виконає N×regex per element → OOM Node worker. 100 = реалістичний
  // максимум для filter по subtree категорій.
  @ArrayMaxSize(100, { message: 'err.dto.good.categories.max' })
  @Matches(UUID_REGEX, { each: true })
  @Transform(({ value }) => (Array.isArray(value) ? value : value ? [value] : undefined))
  goodCategoryIds?: string[];

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  @Max(200)
  limit: number = 50;

  @ApiPropertyOptional({ description: 'Показати видалені' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  showDeleted?: boolean;
}

export class GoodResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() orgId!: string;
  @ApiPropertyOptional() internalCode!: string | null;
  @ApiPropertyOptional() sku!: string | null;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() brandName?: string | null;
  @ApiProperty() unit!: string;
  @ApiPropertyOptional() unitId?: string | null;
  @ApiPropertyOptional() brandId?: string | null;
  @ApiPropertyOptional() purchasePrice!: number | null;
  @ApiProperty() salePrice!: number;
  @ApiPropertyOptional() category!: string | null;
  @ApiPropertyOptional() goodCategoryId?: string | null;
  @ApiPropertyOptional() goodCategoryName?: string | null;
  @ApiPropertyOptional() barcode!: string | null;
  /** Додаткові ШК (GoodBarcode[]) — для сканера/exact-match на фронті. */
  @ApiPropertyOptional({ type: [String] }) barcodes?: string[];
  @ApiPropertyOptional() notes!: string | null;
  @ApiPropertyOptional({ enum: GoodType }) goodType?: GoodType | null;
  @ApiPropertyOptional() preferredSupplierId?: string | null;
  @ApiPropertyOptional() preferredSupplierName?: string | null;
  /** Кастомні статуси-мітки товару (M:N) — активні (deletedAt:null). */
  @ApiPropertyOptional({ type: 'array', items: { type: 'object' } })
  statuses?: { id: string; name: string; color: string }[];
  @ApiPropertyOptional({ type: String, nullable: true }) deletedAt?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class PaginatedGoodsDto {
  @ApiProperty({ type: [GoodResponseDto] }) items!: GoodResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

// в”Ђв”Ђв”Ђ Good UoM в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђ

export class CreateGoodUoMDto {
  @ApiProperty({ description: 'ID одиниці виміру' })
  @IsUUID('4')
  unitOfMeasureId!: string;

  @ApiPropertyOptional({
    example: 1,
    description: 'Коефіцієнт перерахунку (default: з UnitOfMeasure)',
  })
  @IsOptional()
  @IsNumber()
  // coefficient — множник: qty_base = qty * coefficient (1 альт. од. = coefficient базових). 0 → guard→1.
  @Min(0.000001)
  coefficient?: number;

  @ApiPropertyOptional({ description: 'Ширина (м)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  width?: number;

  @ApiPropertyOptional({ description: 'Висота (м)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  height?: number;

  @ApiPropertyOptional({ description: 'Глибина/довжина (м)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  depth?: number;

  @ApiPropertyOptional({ description: "Об'єм (м³)" })
  @IsOptional()
  @IsNumber()
  @Min(0)
  volume?: number;

  @ApiPropertyOptional({ description: 'Вага (кг)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  weight?: number;
}

export class UpdateGoodUoMDto {
  @ApiPropertyOptional({
    example: 1,
    description: 'Коефіцієнт перерахунку до базової одиниці',
  })
  @IsOptional()
  // coefficient — множник: qty_base = qty * coefficient (1 альт. од. = coefficient базових). 0 → guard→1.
  @Min(0.000001)
  coefficient?: number;

  @ApiPropertyOptional({ description: 'Ширина (м)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  width?: number;

  @ApiPropertyOptional({ description: 'Висота (м)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  height?: number;

  @ApiPropertyOptional({ description: 'Глибина/довжина (м)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  depth?: number;

  @ApiPropertyOptional({ description: "Об'єм (м³)" })
  @IsOptional()
  @IsNumber()
  @Min(0)
  volume?: number;

  @ApiPropertyOptional({ description: 'Вага (кг)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  weight?: number;
}

export class GoodUoMResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() unitOfMeasureId!: string;
  @ApiProperty() unitName!: string;
  @ApiProperty() unitShortName!: string;
  @ApiProperty() coefficient!: number;
  @ApiProperty() isDefault!: boolean;
  @ApiPropertyOptional() width?: number | null;
  @ApiPropertyOptional() height?: number | null;
  @ApiPropertyOptional() depth?: number | null;
  @ApiPropertyOptional() volume?: number | null;
  @ApiPropertyOptional() weight?: number | null;
}

// ─── Stock totals ──────────────────────────────────────────

export class GoodStockByWarehouseDto {
  @ApiProperty() warehouseId!: string;
  @ApiProperty() quantity!: number;
}

export class GoodStockTotalDto {
  @ApiProperty() goodId!: string;
  @ApiProperty({ description: 'Сума залишків по всіх складах' }) totalQuantity!: number;
  @ApiProperty({ type: [GoodStockByWarehouseDto] })
  byWarehouse!: GoodStockByWarehouseDto[];
}

// ─── Партії товару ─────────────────────────────────────────
// `total` — реальний COUNT з БД, а не items.length (items cap-иться take: 200).

export class PaginatedGoodBatchesDto {
  @ApiProperty({ type: [StockBatchDto] }) items!: StockBatchDto[];
  @ApiProperty() total!: number;
}

// ─── Цінова історія ────────────────────────────────────────

export class GoodPriceHistoryRowDto {
  @ApiProperty() id!: string;
  // oldPrice null → перша ціна товару (попередньої не було).
  @ApiProperty({ type: Number, nullable: true }) oldPrice!: number | null;
  @ApiProperty() newPrice!: number;
  @ApiProperty({ type: Number, nullable: true }) costPrice!: number | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ type: Date }) createdAt!: Date;
}

export class PaginatedGoodPriceHistoryDto {
  @ApiProperty({ type: [GoodPriceHistoryRowDto] }) items!: GoodPriceHistoryRowDto[];
  @ApiProperty() total!: number;
}
