import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { IdempotencyInterceptor } from './interceptors/idempotency.interceptor';
import { IdempotencyPurgeScheduler } from './interceptors/idempotency-purge.scheduler';
import { IdempotencyPurgeProcessor } from './interceptors/idempotency-purge.processor';
import { DEFAULT_JOB_OPTS } from './scheduler/job-opts';

/**
 * Глобальні cross-cutting провайдери. IdempotencyInterceptor застосовується точково через
 * `@UseInterceptors(IdempotencyInterceptor)` на create-POST у різних модулях — @Global робить його
 * DI-резолвабельним без реєстрації у кожному модулі (залежить лише від глобального PrismaService).
 * Тут же хоститься черга idempotency-purge (A1.3, TTL-очищення протермінованих ключів).
 */
@Global()
@Module({
  imports: [
    BullModule.registerQueue({ name: 'idempotency-purge', defaultJobOptions: DEFAULT_JOB_OPTS }),
  ],
  providers: [IdempotencyInterceptor, IdempotencyPurgeScheduler, IdempotencyPurgeProcessor],
  exports: [IdempotencyInterceptor],
})
export class CommonModule {}
