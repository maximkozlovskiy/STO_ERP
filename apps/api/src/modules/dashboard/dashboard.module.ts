import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';

@Module({
  // JwtModule/ConfigModule прибрано разом з мертвим SSE-stream (tech-debt 2026-09-14) — /dashboard/summary
  // авторизується через глобальний JwtAuthGuard/RolesGuard (stateless, без DI тут).
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
