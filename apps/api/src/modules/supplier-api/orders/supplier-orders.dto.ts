import { ApiProperty } from '@nestjs/swagger';
import {
  PurchaseOrderSupplierApiStatus,
  SupplierOrderSendMode,
  SupplierOrderStatus,
  SupplierProvider,
} from '@prisma/client';

export class SupplierApiOrderLineDto {
  @ApiProperty() id!: string;
  @ApiProperty() goodId!: string;
  @ApiProperty() goodName!: string;
  @ApiProperty() offerKey!: string;
  @ApiProperty({ type: String, nullable: true }) warehouseCode!: string | null;
  @ApiProperty() qtyRequested!: number;
  @ApiProperty({ type: Number, nullable: true, description: 'null — постачальник ще не відповів' })
  qtyConfirmed!: number | null;
  @ApiProperty() priceRequested!: number;
  @ApiProperty({ type: Number, nullable: true }) priceConfirmed!: number | null;
  @ApiProperty() currencyCode!: string;
  @ApiProperty({ type: String, nullable: true }) statusRaw!: string | null;
}

/** Зовнішнє замовлення в постачальника (SupplierOrder). */
export class SupplierApiOrderDto {
  @ApiProperty() id!: string;
  @ApiProperty() connectionId!: string;
  @ApiProperty() connectionName!: string;
  @ApiProperty({ enum: SupplierProvider }) provider!: SupplierProvider;
  @ApiProperty({ type: String, nullable: true }) supplierWarehouseCode!: string | null;
  @ApiProperty({ enum: SupplierOrderStatus }) status!: SupplierOrderStatus;
  @ApiProperty({ type: String, nullable: true }) step!: string | null;
  @ApiProperty({ type: String, nullable: true }) externalOrderId!: string | null;
  @ApiProperty({ type: String, nullable: true }) externalNumber!: string | null;
  @ApiProperty({ type: String, nullable: true }) externalStatusRaw!: string | null;
  @ApiProperty() reference!: string;
  @ApiProperty({ type: String, nullable: true }) sentAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) confirmedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) lastPolledAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) nextPollAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) error!: string | null;
  @ApiProperty({ type: [SupplierApiOrderLineDto] }) lines!: SupplierApiOrderLineDto[];
}

/** Передача замовлення постачальнику через API (BR-PO-011, BR-SCON-009…014). */
export class PurchaseOrderSupplierApiDto {
  @ApiProperty() purchaseOrderId!: string;
  @ApiProperty({ enum: PurchaseOrderSupplierApiStatus })
  supplierApiStatus!: PurchaseOrderSupplierApiStatus;
  @ApiProperty({ type: String, nullable: true }) supplierApiSentAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) supplierApiError!: string | null;
  @ApiProperty({ enum: SupplierOrderSendMode }) sendMode!: SupplierOrderSendMode;
  @ApiProperty({ description: 'Чи має постачальник увімкнене підключення до API' })
  hasConnection!: boolean;
  @ApiProperty({ description: 'Кнопка «Відправити в API» доступна' }) canSend!: boolean;
  @ApiProperty({ description: 'Є непідтверджена кількість, яку можна повернути в список' })
  canRelease!: boolean;
  @ApiProperty({ type: [String], description: 'Попередження (застарілі пропозиції)' })
  warnings!: string[];
  @ApiProperty({ type: [SupplierApiOrderDto] }) orders!: SupplierApiOrderDto[];
}

export class SupplierApiReleaseResultDto {
  @ApiProperty({ description: 'Скільки одиниць повернуто в список купівлі' }) released!: number;
  @ApiProperty({ type: PurchaseOrderSupplierApiDto }) state!: PurchaseOrderSupplierApiDto;
}
