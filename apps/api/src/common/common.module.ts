import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { IdempotencyInterceptor } from './interceptors/idempotency.interceptor';
import { IdempotencyPurgeScheduler } from './interceptors/idempotency-purge.scheduler';
import { IdempotencyPurgeProcessor } from './interceptors/idempotency-purge.processor';
import { DEFAULT_JOB_OPTS } from './scheduler/job-opts';
import { HOST_LOOKUP, hostLookupProvider } from './utils/host-lookup.token';

/**
 * Глобальні cross-cutting провайдери. IdempotencyInterceptor застосовується точково через
 * `@UseInterceptors(IdempotencyInterceptor)` на create-POST у різних модулях — @Global робить його
 * DI-резолвабельним без реєстрації у кожному модулі (залежить лише від глобального PrismaService).
 * Тут же хоститься черга idempotency-purge (A1.3, TTL-очищення протермінованих ключів).
 *
 * `HOST_LOOKUP` — один спільний DNS-резолвер (SSRF resolved-перевірка): @Global робить його
 * DI-резолвабельним у будь-якому клієнті провайдера / сервісі без реєстрації у їхніх модулях;
 * тест-модуль перевизначає токен фейком.
 */
@Global()
@Module({
  imports: [
    BullModule.registerQueue({ name: 'idempotency-purge', defaultJobOptions: DEFAULT_JOB_OPTS }),
  ],
  providers: [
    IdempotencyInterceptor,
    IdempotencyPurgeScheduler,
    IdempotencyPurgeProcessor,
    hostLookupProvider,
  ],
  exports: [IdempotencyInterceptor, HOST_LOOKUP],
})
export class CommonModule {}
