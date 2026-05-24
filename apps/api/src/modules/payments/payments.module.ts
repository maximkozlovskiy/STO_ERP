import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { CheckboxProcessor } from './checkbox.processor';
import { SettlementsModule } from '../settlements/settlements.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WorkOrdersModule } from '../work-orders/work-orders.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'checkbox' }),
    SettlementsModule,
    NotificationsModule,
    WorkOrdersModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService, CheckboxProcessor],
  exports: [PaymentsService],
})
export class PaymentsModule {}
