import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { IntegrationLogService } from './integration-log.service';
import { IntegrationLogsController } from './integration-logs.controller';
import { IntegrationLogPurgeScheduler } from './integration-log-purge.scheduler';
import { IntegrationLogPurgeProcessor } from './integration-log-purge.processor';

@Module({
  imports: [BullModule.registerQueue({ name: 'integration-log-purge' })],
  controllers: [IntegrationLogsController],
  providers: [IntegrationLogService, IntegrationLogPurgeScheduler, IntegrationLogPurgeProcessor],
  // Експортуємо сервіс — payments/purchase-orders модулі використовують wrap() у процесорах.
  exports: [IntegrationLogService],
})
export class IntegrationLogsModule {}
