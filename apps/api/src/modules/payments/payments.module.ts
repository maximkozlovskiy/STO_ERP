import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
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
    // Bug #267: PaymentsService queues loyalty earn after each successful payment
    // (queueEarn → BullMQ job → LoyaltyProcessor → loyaltyService.earn). Без цього
    // імпорту бали лояльності ніколи не нараховувались, бо queueEarn — мертвий код.
    LoyaltyModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService, CheckboxProcessor],
  exports: [PaymentsService],
})
export class PaymentsModule {}
