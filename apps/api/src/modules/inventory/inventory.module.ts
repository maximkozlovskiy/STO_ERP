import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { BatchService } from './batch.service';
import { PricingService } from './pricing.service';
import { StockItemsController } from './stock-items.controller';
import { BatchesController } from './batches.controller';
import { PricingRulesController } from './pricing-rules.controller';

@Module({
  controllers: [StockItemsController, BatchesController, PricingRulesController],
  providers: [InventoryService, BatchService, PricingService],
  exports: [InventoryService, BatchService, PricingService],
})
export class InventoryModule {}
