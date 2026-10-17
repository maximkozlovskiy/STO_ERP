import { Module } from '@nestjs/common';
import { DocumentNumberModule } from '../document-number/document-number.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PurchaseListCoreModule } from './purchase-list-core.module';
import { PurchaseListsController } from './purchase-lists.controller';
import { PurchaseListItemsController } from './purchase-list-items.controller';
import { PurchaseListsService } from './purchase-lists.service';
import { PurchaseListItemsService } from './purchase-list-items.service';
import { PurchaseShortageService } from './purchase-shortage.service';

/**
 * Списки купівлі — HTTP (docs/objects/purchase-list.md). Хуки й розподіл отриманого живуть у
 * PurchaseListCoreModule, яким користуються наряди й замовлення постачальникам.
 */
@Module({
  imports: [PurchaseListCoreModule, DocumentNumberModule, InventoryModule],
  controllers: [PurchaseListsController, PurchaseListItemsController],
  providers: [PurchaseListsService, PurchaseListItemsService, PurchaseShortageService],
})
export class PurchaseListsModule {}
