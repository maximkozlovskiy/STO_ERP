import { Module } from '@nestjs/common';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // NotificationsModule provides NotificationsService.send() — single source of truth
  // for SMS template resolve + branchSettings credentials. Booking must NOT push raw
  // `{ templateCode, params }` jobs directly to the queue — SmsProcessor.process()
  // would see provider=undefined → silent skip ("Невідомий SMS-провайдер").
  // NotificationsModule is @Global() so technically the import is optional, but
  // explicit keeps the dependency graph greppable.
  imports: [NotificationsModule],
  controllers: [BookingController],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}
