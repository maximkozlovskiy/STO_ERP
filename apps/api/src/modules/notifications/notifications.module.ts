import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { SmsProcessor } from './sms.processor';
import { FollowUpProcessor } from './followup.processor';
import { FollowUpScheduler } from './followup.scheduler';

@Global()
@Module({
  imports: [
    BullModule.registerQueue({ name: 'sms' }),
    BullModule.registerQueue({ name: 'followup' }),
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService, SmsProcessor, FollowUpProcessor, FollowUpScheduler],
  exports: [NotificationsService],
})
export class NotificationsModule {}
