import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DEFAULT_JOB_OPTS } from '../../common/scheduler/job-opts';
import { DeadLetterService } from './dead-letter.service';
import { DeadLetterController } from './dead-letter.controller';
import { DeadLetterPurgeScheduler } from './dead-letter-purge.scheduler';
import { DeadLetterPurgeProcessor } from './dead-letter-purge.processor';

/**
 * @Global — 12 BullMQ-процесорів інжектять DeadLetterService у конструктор (через
 * DeadLetterWorkerHost) без імпорту цього модуля у кожен feature-модуль. PrismaService —
 * теж глобальний. Import 1× у AppModule.
 *
 * DLQ retention purge (v1.1): щоденний job видаляє resolved DeadLetterJob старші за retention
 * (per-org + global null-org). Черга dead-letter-purge зареєстрована локально тут.
 */
@Global()
@Module({
  imports: [
    BullModule.registerQueue({
      name: 'dead-letter-purge',
      defaultJobOptions: DEFAULT_JOB_OPTS,
    }),
  ],
  controllers: [DeadLetterController],
  providers: [DeadLetterService, DeadLetterPurgeScheduler, DeadLetterPurgeProcessor],
  exports: [DeadLetterService],
})
export class DeadLetterModule {}
