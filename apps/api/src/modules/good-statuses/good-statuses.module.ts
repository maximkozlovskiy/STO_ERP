import { Module } from '@nestjs/common';
import { GoodStatusesController } from './good-statuses.controller';
import { GoodStatusesService } from './good-statuses.service';

@Module({
  controllers: [GoodStatusesController],
  providers: [GoodStatusesService],
  exports: [GoodStatusesService],
})
export class GoodStatusesModule {}
