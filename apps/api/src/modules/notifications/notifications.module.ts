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
import { TelegramBotProvider } from './providers/telegram-bot.provider';
import { TelegramApiClient } from './providers/telegram-api.client';
import { TelegramRecipientsService } from './telegram-recipients.service';
import { NotificationProviderRegistry } from './providers/provider-registry';
import { NOTIFICATION_PROVIDERS } from './providers/notification-provider.interface';
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
    TelegramApiClient,
    TelegramBotProvider,
    TelegramRecipientsService,
    // Multi-provider реєстрація: реєстр інжектить NOTIFICATION_PROVIDERS як NotificationProvider[].
    // ОДИН factory повертає масив singleton-ів (NestJS 10 не має Angular-style multi:true).
    {
      provide: NOTIFICATION_PROVIDERS,
      useFactory: (
        turbosms: TurboSmsProvider,
        esputnik: EsputnikProvider,
        email: EmailProvider,
        telegramBot: TelegramBotProvider,
      ) => [turbosms, esputnik, email, telegramBot],
      inject: [TurboSmsProvider, EsputnikProvider, EmailProvider, TelegramBotProvider],
    },
    NotificationProviderRegistry,
  ],
  exports: [
    NotificationsService,
    NotificationProviderRegistry,
    TelegramApiClient,
    TelegramRecipientsService,
  ],
})
export class NotificationsModule {}
