import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { PurchaseListLinkService } from './purchase-list-link.service';
import { PurchaseListReceiptService } from './purchase-list-receipt.service';

/**
 * Ядро списків купівлі для інших модулів (без циклу залежностей): хуки життєвого циклу позицій
 * (наряд — WorkOrderStockEffectsModule, замовлення постачальнику — PurchaseOrdersModule, імпорт
 * XLSX) і розподіл отриманого при прийманні (BR-PL-011). Залежить лише від таблиць і складу —
 * не від WorkOrdersModule чи PurchaseOrdersModule.
 */
@Module({
  imports: [InventoryModule],
  providers: [PurchaseListLinkService, PurchaseListReceiptService],
  exports: [PurchaseListLinkService, PurchaseListReceiptService],
})
export class PurchaseListCoreModule {}
