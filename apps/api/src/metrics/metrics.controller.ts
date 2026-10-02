import { Controller, Get, Header, UseGuards, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { MetricsService } from './metrics.service';

/**
 * `/metrics` у форматі Prometheus — для діагностики на місці (ADR-003: прод у клієнта).
 *
 * ЗАКРИТО ГВАРДАМИ навмисно, на відміну від канонічного публічного /metrics: метрики
 * показують внутрішній стан (глибина черг, затримки маршрутів, RSS процесу) — це розвідка
 * для атакуючого і не те, що варто віддавати будь-кому в локальній мережі СТО. Зовнішнього
 * збирача у нас немає (офлайн), тож публічність не дає жодної користі.
 *
 * `SkipThrottle` — скрейп може бути частим; throttler тут лише заважав би.
 */
@Controller({ path: 'metrics', version: VERSION_NEUTRAL })
@UseGuards(JwtAuthGuard, RolesGuard)
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Roles('OWNER', 'ADMIN')
  @SkipThrottle()
  @ApiExcludeEndpoint()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metricsText(): Promise<string> {
    return this.metrics.render();
  }
}
