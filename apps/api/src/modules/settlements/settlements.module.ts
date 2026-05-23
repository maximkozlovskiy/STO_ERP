import { Module } from '@nestjs/common';
import { SettlementsService } from './settlements.service';

@Module({
  providers: [SettlementsService],
  exports: [SettlementsService],
})
export class SettlementsModule {}
