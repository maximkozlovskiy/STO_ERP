import { Module } from '@nestjs/common';
import { SupplierPaymentsService } from './supplier-payments.service';
import { SupplierPaymentsController } from './supplier-payments.controller';
import { SettlementsModule } from '../settlements/settlements.module';

@Module({
  imports: [SettlementsModule],
  controllers: [SupplierPaymentsController],
  providers: [SupplierPaymentsService],
})
export class SupplierPaymentsModule {}
