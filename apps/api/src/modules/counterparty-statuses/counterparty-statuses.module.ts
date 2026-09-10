import { Module } from '@nestjs/common';
import { CounterpartyStatusesController } from './counterparty-statuses.controller';
import { CounterpartyStatusesService } from './counterparty-statuses.service';

@Module({
  controllers: [CounterpartyStatusesController],
  providers: [CounterpartyStatusesService],
  exports: [CounterpartyStatusesService],
})
export class CounterpartyStatusesModule {}
