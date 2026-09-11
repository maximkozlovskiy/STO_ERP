import { Module } from '@nestjs/common';
import { SupplierPaymentsService } from './supplier-payments.service';
import { SupplierPaymentsController } from './supplier-payments.controller';
import { SettlementsModule } from '../settlements/settlements.module';
import { CashModule } from '../cash/cash.module';

@Module({
  imports: [SettlementsModule, CashModule],
  controllers: [SupplierPaymentsController],
  providers: [SupplierPaymentsService],
})
export class SupplierPaymentsModule {}
