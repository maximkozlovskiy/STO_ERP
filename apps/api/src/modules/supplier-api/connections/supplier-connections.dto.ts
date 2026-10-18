import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupplierProvider, SupplierVerifyStatus } from '@prisma/client';

/** Опис поля форми підключення (з реєстру адаптерів). */
export class SupplierFieldSpecDto {
  @ApiProperty() key!: string;
  @ApiProperty() label!: string;
  @ApiProperty() secret!: boolean;
  @ApiProperty() required!: boolean;
  @ApiProperty({ enum: ['string', 'boolean', 'select'] }) type!: 'string' | 'boolean' | 'select';
  @ApiPropertyOptional({ type: [String] }) options?: string[];
  @ApiPropertyOptional() hint?: string;
}

export class SupplierCapabilitiesDto {
  @ApiProperty({ enum: ['online', 'mirror'] }) search!: 'online' | 'mirror';
  @ApiProperty() analogs!: boolean;
  @ApiProperty({ enum: ['direct', 'cart'] }) order!: 'direct' | 'cart';
  @ApiProperty() sandbox!: boolean;
  @ApiProperty() orderPerWarehouse!: boolean;
  @ApiProperty() requiresWarehouseMapping!: boolean;
}

export class SupplierProviderInfoDto {
  @ApiProperty({ enum: SupplierProvider }) provider!: SupplierProvider;
  @ApiProperty() name!: string;
  @ApiProperty({ type: SupplierCapabilitiesDto }) capabilities!: SupplierCapabilitiesDto;
  @ApiProperty({ type: [SupplierFieldSpecDto] }) credentialFields!: SupplierFieldSpecDto[];
  @ApiProperty({ type: [SupplierFieldSpecDto] }) optionFields!: SupplierFieldSpecDto[];
  @ApiProperty({
    type: [SupplierFieldSpecDto],
    description: 'Поля параметрів доставки на кожен наш склад',
  })
  warehouseFields!: SupplierFieldSpecDto[];
}

/** Підключення без секретів (BR-SCON-002): лише `hasCredentials` і перелік заповнених полів. */
export class SupplierConnectionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() counterpartyId!: string;
  @ApiProperty() counterpartyName!: string;
  @ApiProperty({ enum: SupplierProvider }) provider!: SupplierProvider;
  @ApiProperty() providerName!: string;
  @ApiProperty({ nullable: true, type: String }) name!: string | null;
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ nullable: true, type: String }) apiUrl!: string | null;
  @ApiProperty() testMode!: boolean;
  @ApiProperty() priority!: number;
  @ApiProperty({ nullable: true, type: Number }) defaultDeliveryDays!: number | null;
  @ApiProperty() hasCredentials!: boolean;
  @ApiProperty({ type: [String], description: 'Які поля кредів заповнено (без значень)' })
  credentialKeys!: string[];
  @ApiProperty({ type: 'object', additionalProperties: true, description: 'Несекретні параметри' })
  options!: Record<string, unknown>;
  @ApiProperty({ enum: SupplierVerifyStatus }) verifyStatus!: SupplierVerifyStatus;
  @ApiProperty({ nullable: true, type: String }) verifyRequestedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) lastVerifiedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) lastError!: string | null;
  @ApiProperty({ nullable: true, type: String }) catalogSyncedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) catalogSyncStatus!: string | null;
  @ApiProperty({ nullable: true, type: String }) catalogSyncError!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class PaginatedSupplierConnectionsDto {
  @ApiProperty({ type: [SupplierConnectionResponseDto] }) items!: SupplierConnectionResponseDto[];
  @ApiProperty() total!: number;
}

/** Відповідь «поставлено в чергу»: queueUnavailable — Redis недоступний, підхопить sweep. */
export class SupplierQueuedResponseDto {
  @ApiProperty({ type: SupplierConnectionResponseDto }) connection!: SupplierConnectionResponseDto;
  @ApiProperty() queueUnavailable!: boolean;
}
