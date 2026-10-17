import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { ExchangeRatesModule } from '../exchange-rates/exchange-rates.module';
import { WorkOrderStockEffectsService } from './work-order-stock-effects.service';

/**
 * Склад і борг переходів наряду (A3) окремим модулем: крім WorkOrdersModule, його потребує імпорт
 * товарів наряду з XLSX (BR-WO-021 — надлишок резерву після зміни кількостей). Окремий модуль не
 * тягне в XlsxModule весь WorkOrdersModule.
 */
@Module({
  imports: [InventoryModule, SettlementsModule, ExchangeRatesModule],
  providers: [WorkOrderStockEffectsService],
  exports: [WorkOrderStockEffectsService],
})
export class WorkOrderStockEffectsModule {}
