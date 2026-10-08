import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { ExchangeRatesModule } from '../exchange-rates/exchange-rates.module';
import { WorkOrderTotalsService } from './work-order-totals.service';

// Leaf module: WorkOrdersModule, InspectionModule and XlsxModule all need the totals owner,
// and importing the heavy WorkOrdersModule from the latter two would create a dependency cycle.
@Module({
  imports: [SettingsModule, ExchangeRatesModule],
  providers: [WorkOrderTotalsService],
  exports: [WorkOrderTotalsService],
})
export class WorkOrderTotalsModule {}
