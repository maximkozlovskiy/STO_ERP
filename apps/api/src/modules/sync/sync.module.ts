import { Module } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { WorkOrdersModule } from '../work-orders/work-orders.module';

@Module({
  // BR-WO-024: зміна часу чи підйомника запису наряду з планшета — через наряд.
  imports: [WorkOrdersModule],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}
