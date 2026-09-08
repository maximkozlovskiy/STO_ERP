import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { DEFAULT_JOB_OPTS } from '../../common/scheduler/job-opts';
import { IntegrationLogService } from './integration-log.service';
import { IntegrationLogsController } from './integration-logs.controller';
import { IntegrationLogPurgeScheduler } from './integration-log-purge.scheduler';
import { IntegrationLogPurgeProcessor } from './integration-log-purge.processor';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'integration-log-purge',
      defaultJobOptions: DEFAULT_JOB_OPTS,
    }),
  ],
  controllers: [IntegrationLogsController],
  providers: [IntegrationLogService, IntegrationLogPurgeScheduler, IntegrationLogPurgeProcessor],
  // Експортуємо сервіс — payments/purchase-orders модулі використовують wrap() у процесорах.
  exports: [IntegrationLogService],
})
export class IntegrationLogsModule {}
