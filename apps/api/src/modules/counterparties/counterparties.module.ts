import { Module } from '@nestjs/common';
import { CounterpartiesController } from './counterparties.controller';
import { CounterpartiesService } from './counterparties.service';
import { AuditModule } from '../audit/audit.module';
import { CounterpartyStatusesModule } from '../counterparty-statuses/counterparty-statuses.module';

@Module({
  // AuditModule (C1b), CounterpartyStatusesModule — assign/unassign скидає кеш довідника статусів
  imports: [AuditModule, CounterpartyStatusesModule],
  controllers: [CounterpartiesController],
  providers: [CounterpartiesService],
  exports: [CounterpartiesService],
})
export class CounterpartiesModule {}
