import { Module } from '@nestjs/common';
import { LiftsController, ZonesController } from './zones.controller';
import { ZonesService } from './zones.service';

@Module({
  controllers: [ZonesController, LiftsController],
  providers: [ZonesService],
  exports: [ZonesService],
})
export class ZonesModule {}
