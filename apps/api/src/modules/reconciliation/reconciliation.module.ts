import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ReconciliationScheduler } from './reconciliation.scheduler';
import { ReconciliationProcessor } from './reconciliation.processor';
import { DEFAULT_JOB_OPTS } from '../../common/scheduler/job-opts';

/**
 * A3 — per-org drift-detection інваріантів (stock/balance/paidAmount). Read-only, лог-only.
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: 'reconciliation', defaultJobOptions: DEFAULT_JOB_OPTS }),
  ],
  providers: [ReconciliationScheduler, ReconciliationProcessor],
})
export class ReconciliationModule {}
