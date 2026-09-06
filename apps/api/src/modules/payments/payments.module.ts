import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { CheckboxProcessor } from './checkbox.processor';
import { CheckboxClient } from './checkbox.client';
import { CashShiftService } from './cash-shift.service';
import { CashShiftController } from './cash-shift.controller';
import { SettlementsModule } from '../settlements/settlements.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WorkOrdersModule } from '../work-orders/work-orders.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'checkbox' }),
    SettlementsModule,
    NotificationsModule,
    WorkOrdersModule,
    // PaymentsService queues loyalty earn (queueEarn → BullMQ → LoyaltyProcessor → loyaltyService.earn)
    // — without this import queueEarn was dead code and loyalty points were never accrued.
    LoyaltyModule,
  ],
  controllers: [PaymentsController, CashShiftController],
  providers: [PaymentsService, CheckboxProcessor, CheckboxClient, CashShiftService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
