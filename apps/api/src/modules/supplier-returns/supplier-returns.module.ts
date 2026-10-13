import { Module } from '@nestjs/common';
import { SupplierReturnsService } from './supplier-returns.service';
import { SupplierReturnsController } from './supplier-returns.controller';
import { InventoryModule } from '../inventory/inventory.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { LinesSummaryModule } from '../lines-summary/lines-summary.module';

@Module({
  imports: [LinesSummaryModule, InventoryModule, SettlementsModule],
  controllers: [SupplierReturnsController],
  providers: [SupplierReturnsService],
})
export class SupplierReturnsModule {}
