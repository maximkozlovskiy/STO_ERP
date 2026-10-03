import { ApiProperty } from '@nestjs/swagger';
import { StockMovementType } from '@prisma/client';

// DTO відповідей StockItemsController. Усі 6 роутів раніше повертали inline-форми
// → у Swagger `200: {}`, тож кодогенерація для web нічого не давала.
// Усе — КЛАСИ, не interface: Swagger читає лише класи з @ApiProperty
// (interface не потрапляє у components.schemas — docs/GOTCHAS.md).

// ─── GET /stock-items ──────────────────────────────────────

export class StockItemRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() goodId!: string;
  @ApiProperty() goodName!: string;
  @ApiProperty({ type: String, nullable: true }) goodSku!: string | null;
  @ApiProperty({ type: String, nullable: true }) goodBrand!: string | null;
  @ApiProperty({ description: 'Одиниця виміру товару' }) unit!: string;
  @ApiProperty() salePrice!: number;
  @ApiProperty() warehouseId!: string;
  @ApiProperty() warehouseName!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty({ description: 'Зарезервовано під наряди' }) reserved!: number;
  @ApiProperty({ description: 'quantity − reserved' }) available!: number;
  // null → мінімальний залишок не заданий, тож isLow завжди false.
  @ApiProperty({ type: Number, nullable: true }) minStock!: number | null;
  @ApiProperty({ description: 'minStock задано і quantity <= minStock' }) isLow!: boolean;
}

// ─── GET /stock-items/low ──────────────────────────────────
// minStock тут НЕ nullable: запит фільтрує `minStock IS NOT NULL`.

export class LowStockItemDto {
  @ApiProperty() goodId!: string;
  @ApiProperty() goodName!: string;
  @ApiProperty({ type: String, nullable: true }) goodSku!: string | null;
  @ApiProperty() unit!: string;
  @ApiProperty() warehouseName!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty() minStock!: number;
  @ApiProperty({ description: 'minStock − quantity' }) deficit!: number;
}

// ─── GET /stock-items/by-document ──────────────────────────

export class StockDocumentMovementDto {
  // type — рядок, а не enum StockMovementType: byDocument бере `m.type` з
  // Prisma без нормалізації, але значення завжди з enum.
  @ApiProperty({ enum: StockMovementType }) type!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty({ type: Date }) createdAt!: Date;
}

export class StockByDocumentGroupDto {
  // documentType/documentId null → рух без документа-джерела (ручна корекція).
  @ApiProperty({ type: String, nullable: true }) documentType!: string | null;
  @ApiProperty({ type: String, nullable: true }) documentId!: string | null;
  @ApiProperty({ description: 'Людиночитна мітка документа' }) docLabel!: string;
  @ApiProperty({ type: [StockDocumentMovementDto] })
  movements!: StockDocumentMovementDto[];
}

export class StockByDocumentGoodDto {
  @ApiProperty() goodId!: string;
  @ApiProperty() goodName!: string;
  @ApiProperty({ type: String, nullable: true }) goodSku!: string | null;
  @ApiProperty({ type: String, nullable: true }) goodBrand!: string | null;
  @ApiProperty() goodUnit!: string;
  @ApiProperty() totalQuantity!: number;
  @ApiProperty({ type: [StockByDocumentGroupDto] })
  documents!: StockByDocumentGroupDto[];
}

export class StockByDocumentResponseDto {
  @ApiProperty({ type: [StockByDocumentGoodDto] }) goods!: StockByDocumentGoodDto[];
}

// ─── GET /stock-items/by-batch ─────────────────────────────

export class BatchConsumptionRowDto {
  // НЕ nullable: у схемі BatchConsumption обидва поля — `String` без `?`
  // (07_inventory.prisma), а byBatch() мапить їх дослівно, без `?? null`.
  // Споживання завжди має документ-джерело — на відміну від StockMovement,
  // де ручна корекція лишає documentType/documentId порожніми.
  @ApiProperty() documentType!: string;
  @ApiProperty() documentId!: string;
  @ApiProperty() docLabel!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty({ type: Date }) createdAt!: Date;
}

export class StockByBatchGoodDto {
  @ApiProperty() goodId!: string;
  @ApiProperty() goodName!: string;
  @ApiProperty({ type: String, nullable: true }) goodSku!: string | null;
  @ApiProperty({ type: String, nullable: true }) goodBrand!: string | null;
  @ApiProperty() batchId!: string;
  @ApiProperty({ type: String, nullable: true }) batchNumber!: string | null;
  @ApiProperty() receivedQty!: number;
  @ApiProperty() remainingQty!: number;
  @ApiProperty() costPrice!: number;
  @ApiProperty() salePrice!: number;
  @ApiProperty({ type: [BatchConsumptionRowDto] })
  consumptions!: BatchConsumptionRowDto[];
}

export class StockByBatchGroupDto {
  @ApiProperty({ description: '`<номер ПЗ|manual>::<warehouseId>`' }) batchGroupKey!: string;
  // poNumber/poDate null → партія створена не з замовлення постачальнику (manual).
  @ApiProperty({ type: String, nullable: true }) poNumber!: string | null;
  @ApiProperty({ type: Date, nullable: true }) poDate!: Date | null;
  @ApiProperty() warehouseName!: string;
  @ApiProperty({ type: [StockByBatchGoodDto] }) goods!: StockByBatchGoodDto[];
}

export class StockByBatchResponseDto {
  @ApiProperty({ type: [StockByBatchGroupDto] }) batches!: StockByBatchGroupDto[];
}

// ─── GET /stock-items/movements ────────────────────────────

export class StockMovementRowDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: StockMovementType }) type!: StockMovementType;
  @ApiProperty() quantity!: number;
  @ApiProperty({ type: Number, nullable: true }) price!: number | null;
  @ApiProperty() goodId!: string;
  @ApiProperty() goodName!: string;
  @ApiProperty({ type: String, nullable: true }) goodSku!: string | null;
  @ApiProperty() warehouseId!: string;
  @ApiProperty() warehouseName!: string;
  @ApiProperty({ type: String, nullable: true }) documentType!: string | null;
  @ApiProperty({ type: String, nullable: true }) documentId!: string | null;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ type: Date }) createdAt!: Date;
}

export class PaginatedStockMovementsDto {
  @ApiProperty({ type: [StockMovementRowDto] }) items!: StockMovementRowDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

// ─── PATCH /stock-items/:id/min-stock ──────────────────────

export class UpdateMinStockResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ type: Number, nullable: true }) minStock!: number | null;
}
