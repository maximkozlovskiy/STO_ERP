import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { StockItemsController } from './stock-items.controller';

@Module({
  controllers: [StockItemsController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
