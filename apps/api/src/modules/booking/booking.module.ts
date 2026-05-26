import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'sms' })],
  controllers: [BookingController],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}
