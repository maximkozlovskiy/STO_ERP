import { Module } from '@nestjs/common';
import { SupplierPaymentsService } from './supplier-payments.service';
import { SupplierPaymentsController } from './supplier-payments.controller';
import { SettlementsModule } from '../settlements/settlements.module';
import { CashModule } from '../cash/cash.module';
import { ExchangeRatesModule } from '../exchange-rates/exchange-rates.module';

@Module({
  imports: [SettlementsModule, CashModule, ExchangeRatesModule],
  controllers: [SupplierPaymentsController],
  providers: [SupplierPaymentsService],
  // Bank reconciliation creates and confirms a supplier payment from an outgoing bank row (BR-BANK-028).
  exports: [SupplierPaymentsService],
})
export class SupplierPaymentsModule {}
