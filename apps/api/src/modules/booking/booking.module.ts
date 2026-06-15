import { Module } from '@nestjs/common';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // Bug #506: NotificationsModule provides NotificationsService.send() — single
  // source of truth for SMS template resolve + branchSettings credentials.
  // Removed BullModule.registerQueue({ name: 'sms' }) — booking no longer
  // bypasses NotificationsService to push raw `{ templateCode, params }` jobs.
  // NotificationsModule is @Global() so technically the import is optional, but
  // explicit keeps the dependency graph greppable.
  imports: [NotificationsModule],
  controllers: [BookingController],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}
