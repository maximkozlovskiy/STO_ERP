import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { CheckboxProcessor } from './checkbox.processor';
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
  controllers: [PaymentsController],
  providers: [PaymentsService, CheckboxProcessor],
  exports: [PaymentsService],
})
export class PaymentsModule {}
