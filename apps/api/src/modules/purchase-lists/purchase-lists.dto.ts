import {
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  OfferChosenBy,
  PurchaseListItemSource,
  PurchaseListItemStatus,
  PurchaseListStatus,
  PurchaseOrderStatus,
  WorkOrderStatus,
} from '@prisma/client';
import { emptyToUndefined } from '../../common/transforms/empty-to-undefined';

/**
 * Тіла запитів — zod-схеми `@sto/shared` (purchase-list.schema.ts, ZodValidationPipe); тут лише
 * параметри списків і відповіді (типи для OpenAPI → web).
 */

// ─── Запити списків ─────────────────────────────────────────────────────────────

export class PurchaseListQueryDto {
  @ApiPropertyOptional({ enum: PurchaseListStatus })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(PurchaseListStatus)
  status?: PurchaseListStatus;

  @ApiPropertyOptional({ description: 'Пошук за номером і назвою' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

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

/** `supplierId=none` — позиції без постачальника (BR-PL-008: їх не замовити). */
export class PurchaseListItemQueryDto {
  @ApiPropertyOptional({ enum: PurchaseListItemStatus })
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsEnum(PurchaseListItemStatus)
  status?: PurchaseListItemStatus;

  @ApiPropertyOptional({ description: "UUID постачальника або 'none' — без постачальника" })
  @IsOptional()
  @Transform(emptyToUndefined)
  @ValidateIf((_o, v) => v !== 'none')
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional() @IsOptional() @Transform(emptyToUndefined) @IsUUID() warehouseId?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToUndefined) @IsUUID() workOrderId?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToUndefined) @IsUUID() listId?: string;

  @ApiPropertyOptional({ description: 'Пошук за назвою товару, артикулом і кодом' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: ['createdAt', 'quantity'] })
  @IsOptional()
  @IsIn(['createdAt', 'quantity'])
  sortBy?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortDir?: 'asc' | 'desc';

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
  @Min(1)
  @Max(200)
  limit: number = 50;
}

export class ShortageQueryDto {
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToUndefined) @IsUUID() warehouseId?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(emptyToUndefined) @IsUUID() workOrderId?: string;

  @ApiPropertyOptional({ default: 200, description: 'Скільки рядків нестачі повернути' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(500)
  limit: number = 200;
}

// ─── Відповіді ──────────────────────────────────────────────────────────────────

export class PurchaseListItemResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() listId!: string;
  @ApiProperty() listNumber!: string;
  @ApiProperty({ enum: PurchaseListStatus }) listStatus!: PurchaseListStatus;
  @ApiProperty() goodId!: string;
  @ApiProperty() goodName!: string;
  @ApiProperty({ type: String, nullable: true }) goodSku!: string | null;
  @ApiProperty({ type: String, nullable: true }) goodCode!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Базова одиниця товару' })
  goodUnit!: string | null;
  @ApiProperty() warehouseId!: string;
  @ApiProperty() warehouseName!: string;
  @ApiProperty({ description: 'Кількість у базових одиницях (BR-PL-002)' }) quantity!: number;
  @ApiProperty() receivedQty!: number;
  @ApiProperty() reservedQty!: number;
  @ApiProperty({ enum: PurchaseListItemStatus }) status!: PurchaseListItemStatus;
  @ApiProperty({ enum: PurchaseListItemSource }) source!: PurchaseListItemSource;
  @ApiProperty({ type: String, nullable: true }) workOrderId!: string | null;
  @ApiProperty({ type: String, nullable: true }) workOrderNumber!: string | null;
  @ApiProperty({ enum: WorkOrderStatus, nullable: true })
  workOrderStatus!: WorkOrderStatus | null;
  @ApiProperty({ type: String, nullable: true }) workOrderPartId!: string | null;
  @ApiProperty({ type: String, nullable: true }) supplierId!: string | null;
  @ApiProperty({ type: String, nullable: true }) supplierName!: string | null;
  @ApiProperty({ type: Number, nullable: true }) expectedPrice!: number | null;
  @ApiProperty({ type: String, nullable: true }) purchaseOrderId!: string | null;
  @ApiProperty({ type: String, nullable: true }) purchaseOrderNumber!: string | null;
  @ApiProperty({ enum: PurchaseOrderStatus, nullable: true })
  purchaseOrderStatus!: PurchaseOrderStatus | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  // Знімок обраної пропозиції постачальника (BR-SOFR-006, BR-PL-017…019).
  @ApiProperty({ type: String, nullable: true }) offerConnectionId!: string | null;
  @ApiProperty({ type: String, nullable: true }) offerKey!: string | null;
  @ApiProperty({ type: String, nullable: true }) offerSupplierItemId!: string | null;
  @ApiProperty({ type: String, nullable: true }) offerArticle!: string | null;
  @ApiProperty({ type: String, nullable: true }) offerBrand!: string | null;
  @ApiProperty({ type: String, nullable: true }) offerWarehouseCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) offerWarehouseName!: string | null;
  @ApiProperty({ type: Number, nullable: true }) offerDeliveryDays!: number | null;
  @ApiProperty({ type: String, nullable: true }) offerDeliveryDate!: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Ціна пропозиції у валюті постачальника; null для ролей без закупівельних цін',
  })
  offerPrice!: number | null;
  @ApiProperty({ type: String, nullable: true }) offerCurrencyCode!: string | null;
  @ApiProperty({ type: Number, nullable: true }) offerMultiplicity!: number | null;
  @ApiProperty({ type: Boolean, nullable: true }) offerIsAnalog!: boolean | null;
  @ApiProperty({ type: String, nullable: true }) offeredAt!: string | null;
  @ApiProperty({ enum: OfferChosenBy, nullable: true }) offerChosenBy!: OfferChosenBy | null;
  @ApiProperty({ type: String, nullable: true, description: 'Товар, який замінив аналог' })
  originalGoodId!: string | null;
  @ApiPropertyOptional({
    description: 'Кількість позиції більша за кількість обраної пропозиції (BR-PL-019)',
  })
  offerQtyExceeded?: boolean;
  @ApiProperty() createdAt!: string;
}

export class PaginatedPurchaseListItemsDto {
  @ApiProperty({ type: [PurchaseListItemResponseDto] }) items!: PurchaseListItemResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

export class PurchaseListResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() number!: string;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty({ enum: PurchaseListStatus }) status!: PurchaseListStatus;
  @ApiProperty({ type: String, nullable: true }) warehouseId!: string | null;
  @ApiProperty({ type: String, nullable: true }) warehouseName!: string | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: String, nullable: true }) mergedIntoId!: string | null;
  @ApiProperty({ type: String, nullable: true }) mergedIntoNumber!: string | null;
  @ApiProperty({ type: String, nullable: true }) closedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ description: 'Невидалені позиції, крім скасованих' }) itemsCount!: number;
  @ApiProperty() openCount!: number;
  @ApiProperty() orderedCount!: number;
  @ApiProperty() receivedCount!: number;
}

export class PurchaseListDetailDto extends PurchaseListResponseDto {
  @ApiProperty({ type: [PurchaseListItemResponseDto] }) items!: PurchaseListItemResponseDto[];
}

export class PaginatedPurchaseListsDto {
  @ApiProperty({ type: [PurchaseListResponseDto] }) items!: PurchaseListResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

export class FromWorkOrderResultDto {
  @ApiProperty({ type: PurchaseListResponseDto }) list!: PurchaseListResponseDto;
  @ApiProperty({ type: [PurchaseListItemResponseDto] }) items!: PurchaseListItemResponseDto[];
}

export class CreatedOrderDto {
  @ApiProperty() id!: string;
  @ApiProperty() number!: string;
  @ApiProperty() supplierId!: string;
  @ApiProperty() warehouseId!: string;
  @ApiProperty() itemsCount!: number;
}

export class CreateOrdersResultDto {
  @ApiProperty({ type: [CreatedOrderDto] }) orders!: CreatedOrderDto[];
}

export class ReleaseReservationResultDto {
  @ApiProperty({ description: 'Знято з резерву (базові одиниці)' }) released!: number;
  @ApiProperty({ type: PurchaseListItemResponseDto }) item!: PurchaseListItemResponseDto;
}

export class BulkResultDto {
  @ApiProperty() count!: number;
}

export class ShortageRowDto {
  @ApiProperty() workOrderId!: string;
  @ApiProperty() workOrderNumber!: string;
  @ApiProperty({ enum: WorkOrderStatus }) workOrderStatus!: WorkOrderStatus;
  @ApiProperty({ type: String, nullable: true }) plannedAt!: string | null;
  @ApiProperty() workOrderPartId!: string;
  @ApiProperty() goodId!: string;
  @ApiProperty() goodName!: string;
  @ApiProperty({ type: String, nullable: true }) goodSku!: string | null;
  @ApiProperty({ type: String, nullable: true }) goodUnit!: string | null;
  @ApiProperty() warehouseId!: string;
  @ApiProperty() warehouseName!: string;
  @ApiProperty({ description: 'Потреба рядка в базових одиницях' }) required!: number;
  @ApiProperty({ description: 'Покрито резервом наряду' }) reserved!: number;
  @ApiProperty({ description: 'Покрито позиціями списків цього рядка (OPEN + недоотримане)' })
  inLists!: number;
  @ApiProperty({ description: 'Покрито вільним залишком і ручними позиціями (FIFO між нарядами)' })
  fromPool!: number;
  @ApiProperty({ description: 'Непокрито' }) shortage!: number;
  @ApiProperty({ type: String, nullable: true }) preferredSupplierId!: string | null;
}

export class ShortageResponseDto {
  @ApiProperty({ type: [ShortageRowDto] }) items!: ShortageRowDto[];
  @ApiProperty({ description: 'Рядків більше, ніж limit' }) truncated!: boolean;
}

export class WorkOrderPartShortageDto {
  @ApiProperty() workOrderPartId!: string;
  /** Непокрита потреба рядка — у БАЗОВИХ одиницях товару (BR-PL-002). */
  @ApiProperty() shortage!: number;
  /** Базова одиниця товару — підпис до `shortage` (не одиниця рядка наряду, Bug #886). */
  @ApiProperty({ type: String, nullable: true }) goodUnit!: string | null;
}

export class WorkOrderProcurementDto {
  @ApiProperty({ type: [PurchaseListItemResponseDto] }) items!: PurchaseListItemResponseDto[];
  @ApiProperty({ type: [WorkOrderPartShortageDto] }) shortage!: WorkOrderPartShortageDto[];
}

// ─── Пов'язані документи (BR-PL-020) ────────────────────────────────────────────

export class PurchaseListLinkedWorkOrderRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() number!: string;
  @ApiProperty({ enum: WorkOrderStatus }) status!: WorkOrderStatus;
}

export class PurchaseListLinkedPurchaseOrderRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() number!: string;
  @ApiProperty({ enum: PurchaseOrderStatus }) status!: PurchaseOrderStatus;
  /** Сума замовлення у валюті замовлення. */
  @ApiProperty() totalAmount!: number;
  @ApiProperty({ type: String, nullable: true, description: 'Символ (або код) валюти замовлення' })
  currencySymbol!: string | null;
}

export class PurchaseListLinkedListRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() number!: string;
  @ApiProperty({ enum: PurchaseListStatus }) status!: PurchaseListStatus;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class PurchaseListLinkedDocumentsDto {
  @ApiProperty({ type: [PurchaseListLinkedWorkOrderRowDto] })
  workOrders!: PurchaseListLinkedWorkOrderRowDto[];
  @ApiProperty({ type: [PurchaseListLinkedPurchaseOrderRowDto] })
  purchaseOrders!: PurchaseListLinkedPurchaseOrderRowDto[];
  @ApiProperty({
    type: [PurchaseListLinkedListRowDto],
    description: "Списки, об'єднані в цей (BR-PL-006)",
  })
  purchaseLists!: PurchaseListLinkedListRowDto[];
}

export class PurchaseListLinkedCountsEntryDto {
  @ApiProperty() workOrders!: number;
  @ApiProperty() purchaseOrders!: number;
  @ApiProperty() purchaseLists!: number;
}
