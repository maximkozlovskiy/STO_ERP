import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { SmsProcessor } from './sms.processor';

@Global()
@Module({
  imports: [BullModule.registerQueue({ name: 'sms' })],
  controllers: [NotificationsController],
  providers: [NotificationsService, SmsProcessor],
  exports: [NotificationsService],
})
export class NotificationsModule {}
