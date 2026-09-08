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
import { EmailProvider } from './providers/email.provider';
import { NotificationProviderRegistry } from './providers/provider-registry';
import { DEFAULT_JOB_OPTS } from '../../common/scheduler/job-opts';

@Global()
@Module({
  imports: [
    BullModule.registerQueue({ name: 'sms', defaultJobOptions: DEFAULT_JOB_OPTS }),
    BullModule.registerQueue({ name: 'followup', defaultJobOptions: DEFAULT_JOB_OPTS }),
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
    EmailProvider,
    NotificationProviderRegistry,
  ],
  exports: [NotificationsService, NotificationProviderRegistry],
})
export class NotificationsModule {}
