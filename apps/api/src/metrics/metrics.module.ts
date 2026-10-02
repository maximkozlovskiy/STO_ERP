import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';

/**
 * Локальні метрики (ADR-001: усе в межах процесу, жодних зовнішніх збирачів).
 * Інтерсептор експортується, щоб AppModule підключив його глобально.
 */
@Module({
  imports: [BullModule.registerQueue({ name: 'sms' })],
  controllers: [MetricsController],
  providers: [MetricsService, HttpMetricsInterceptor],
  exports: [MetricsService, HttpMetricsInterceptor],
})
export class MetricsModule {}
