import { Global, Module } from '@nestjs/common';
import { IdempotencyInterceptor } from './interceptors/idempotency.interceptor';

/**
 * Глобальні cross-cutting провайдери. IdempotencyInterceptor застосовується точково через
 * `@UseInterceptors(IdempotencyInterceptor)` на create-POST у різних модулях — @Global робить його
 * DI-резолвабельним без реєстрації у кожному модулі (залежить лише від глобального PrismaService).
 */
@Global()
@Module({
  providers: [IdempotencyInterceptor],
  exports: [IdempotencyInterceptor],
})
export class CommonModule {}
