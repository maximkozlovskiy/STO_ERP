import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { DEFAULT_JOB_OPTS } from '../../common/scheduler/job-opts';
import { AuditModule } from '../audit/audit.module';
import {
  CounterpartyTelegramController,
  EmployeeTelegramController,
  TelegramBotSettingsController,
} from './telegram-bot.controller';
import { TelegramBotProcessor } from './telegram-bot.processor';
import { TelegramBotScheduler } from './telegram-bot.scheduler';
import { TelegramBotService } from './telegram-bot.service';

/**
 * Власний Telegram-бот організації (docs/objects/automation.md, BR-AUT-040, 041): підключення
 * токена, коди підписки, опитування `getUpdates` чергою `telegram-bot`. Надсилання — провайдер
 * `telegram-bot` у `NotificationsModule` (глобальний) через чергу `sms`.
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: 'telegram-bot', defaultJobOptions: DEFAULT_JOB_OPTS }),
    AuditModule,
  ],
  controllers: [
    TelegramBotSettingsController,
    CounterpartyTelegramController,
    EmployeeTelegramController,
  ],
  providers: [TelegramBotService, TelegramBotScheduler, TelegramBotProcessor],
})
export class TelegramBotModule {}
