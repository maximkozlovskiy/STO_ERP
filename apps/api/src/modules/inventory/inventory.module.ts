import { Module } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { BatchService } from './batch.service';
import { PricingService } from './pricing.service';
import { StockItemsController } from './stock-items.controller';
import { BatchesController } from './batches.controller';
import { PricingRulesController } from './pricing-rules.controller';
import { SettingsModule } from '../settings/settings.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  // SettingsModule — для costMethod (Метод списання партій) у createMovement.
  // Settings не залежить від Inventory → без circular DI.
  // AuditModule — C1b: аудит pricing-rules CRUD (прямо в контролері).
  imports: [SettingsModule, AuditModule],
  controllers: [StockItemsController, BatchesController, PricingRulesController],
  providers: [InventoryService, BatchService, PricingService],
  exports: [InventoryService, BatchService, PricingService],
})
export class InventoryModule {}
