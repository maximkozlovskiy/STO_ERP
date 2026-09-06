import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotificationsService } from './notifications.service';
import {
  NotificationsController,
  NotificationProvidersController,
  NotificationChannelsController,
} from './notifications.controller';
import { SmsProcessor } from './sms.processor';
import { FollowUpProcessor } from './followup.processor';
import { FollowUpScheduler } from './followup.scheduler';
import { TurboSmsProvider } from './providers/turbosms.provider';
import { EsputnikProvider } from './providers/esputnik.provider';
import { NotificationProviderRegistry } from './providers/provider-registry';

@Global()
@Module({
  imports: [
    BullModule.registerQueue({ name: 'sms' }),
    BullModule.registerQueue({ name: 'followup' }),
  ],
  controllers: [
    NotificationsController,
    NotificationProvidersController,
    NotificationChannelsController,
  ],
  providers: [
    NotificationsService,
    SmsProcessor,
    FollowUpProcessor,
    FollowUpScheduler,
    TurboSmsProvider,
    EsputnikProvider,
    NotificationProviderRegistry,
  ],
  exports: [NotificationsService, NotificationProviderRegistry],
})
export class NotificationsModule {}
