import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  OfferChosenBy,
  PurchaseListItemSource,
  PurchaseListItemStatus,
  SupplierOfferRequestStatus,
  SupplierProvider,
  SupplierStrategy,
} from '@prisma/client';

const NOT_SELECTABLE_REASONS = [
  'itemNotOpen',
  'noExchangeRate',
  'analogFromWorkOrder',
  'analogShowOnly',
  'analogNotInCatalog',
  'analogAmbiguous',
] as const;

/** Нормалізована пропозиція (BR-SOFR-001) + оцінка для позиції. Ціни — null для ролей без закупівельних. */
export class SupplierOfferDto {
  @ApiProperty() id!: string;
  @ApiProperty() connectionId!: string;
  @ApiProperty() supplierItemId!: string;
  @ApiProperty() article!: string;
  @ApiProperty({ type: String, nullable: true }) brand!: string | null;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Ціна у валюті постачальника' })
  price!: number | null;
  @ApiProperty() currencyCode!: string;
  @ApiProperty({ type: Number, nullable: true, description: 'Ціна в гривні за поточним курсом' })
  priceUah!: number | null;
  @ApiProperty() qty!: number;
  @ApiProperty() qtyIsLowerBound!: boolean;
  @ApiProperty({ type: String, nullable: true }) warehouseCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) warehouseName!: string | null;
  @ApiProperty({ type: Number, nullable: true }) deliveryDays!: number | null;
  @ApiProperty({ type: String, nullable: true }) deliveryDate!: string | null;
  @ApiProperty({ type: Number, nullable: true }) multiplicity!: number | null;
  @ApiProperty() isAnalog!: boolean;
  @ApiProperty() offerKey!: string;
  @ApiProperty({ type: String, nullable: true }) matchedGoodId!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: ['matched', 'ambiguous', 'notFound'] })
  matchStatus!: string | null;
  @ApiProperty() fetchedAt!: string;
  @ApiProperty({ description: 'Старша за supplierOfferTtlMinutes' }) stale!: boolean;
  @ApiProperty() selectable!: boolean;
  @ApiProperty({ type: String, nullable: true, enum: NOT_SELECTABLE_REASONS })
  notSelectableReason!: (typeof NOT_SELECTABLE_REASONS)[number] | null;
  @ApiProperty({ description: 'Вибір замінить товар позиції (аналог)' }) replacesGood!: boolean;
  @ApiProperty({ description: 'Ця пропозиція обрана в позиції' }) chosen!: boolean;
}

/** Стан запиту до одного підключення для позиції (чіп у діалозі пропозицій). */
export class SupplierOfferRequestDto {
  @ApiProperty() id!: string;
  @ApiProperty() connectionId!: string;
  @ApiProperty() connectionName!: string;
  @ApiProperty({ enum: SupplierProvider }) provider!: SupplierProvider;
  @ApiProperty() supplierId!: string;
  @ApiProperty() supplierName!: string;
  @ApiProperty({ enum: SupplierOfferRequestStatus }) status!: SupplierOfferRequestStatus;
  @ApiProperty() fromCache!: boolean;
  @ApiProperty({ type: String, nullable: true, description: 'Коли отримано пропозиції' })
  fetchedAt!: string | null;
  @ApiProperty() stale!: boolean;
  @ApiProperty({ description: 'Дзеркало каталогу старше подвоєного інтервалу (AVD)' })
  mirrorStale!: boolean;
  @ApiProperty({ type: String, nullable: true, description: 'Повтор о (немає зв’язку / ліміт)' })
  nextRetryAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) error!: string | null;
  @ApiProperty({ type: [SupplierOfferDto] }) offers!: SupplierOfferDto[];
}

export class SupplierOfferItemDto {
  @ApiProperty() itemId!: string;
  @ApiProperty() goodId!: string;
  @ApiProperty() goodName!: string;
  @ApiProperty({ type: String, nullable: true }) article!: string | null;
  @ApiProperty({ type: String, nullable: true }) brand!: string | null;
  @ApiProperty() quantity!: number;
  @ApiProperty({ enum: PurchaseListItemStatus }) status!: PurchaseListItemStatus;
  @ApiProperty({ enum: PurchaseListItemSource }) source!: PurchaseListItemSource;
  @ApiProperty({ type: String, nullable: true }) chosenOfferKey!: string | null;
  @ApiProperty({ type: String, nullable: true }) chosenConnectionId!: string | null;
  @ApiProperty({ enum: OfferChosenBy, nullable: true }) chosenBy!: OfferChosenBy | null;
  @ApiProperty({ type: [SupplierOfferRequestDto] }) requests!: SupplierOfferRequestDto[];
}

export class SupplierOfferBatchDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: OfferChosenBy }) purpose!: OfferChosenBy;
  @ApiProperty({ enum: SupplierStrategy, nullable: true }) strategy!: SupplierStrategy | null;
  @ApiProperty({ description: 'Усі запити завершено (готово / помилка)' }) done!: boolean;
  @ApiProperty({ type: String, nullable: true }) completedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: [SupplierOfferItemDto] }) items!: SupplierOfferItemDto[];
}

export class SupplierOfferSearchResultDto extends SupplierOfferBatchDto {
  @ApiProperty({ description: 'Redis недоступний — запити підхопить sweep' })
  queueUnavailable!: boolean;
  @ApiProperty({ description: 'Немає увімкнених підключень' }) noConnections!: boolean;
  @ApiProperty({ type: [String], description: 'Позиції без артикула — не шукались' })
  skippedItemIds!: string[];
}

export class SupplierItemOffersDto {
  @ApiProperty({ type: SupplierOfferItemDto }) item!: SupplierOfferItemDto;
}

export class SupplierOfferChooseResultDto {
  @ApiProperty() itemId!: string;
  @ApiPropertyOptional({ description: 'Товар позиції замінено аналогом' }) goodReplaced?: boolean;
}
