import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { WorkOrdersService } from './work-orders.service';

/**
 * Публічний (без auth) endpoint для перегляду кошторису за share-токеном.
 *
 * Окремий route prefix `public/work-orders` (НЕ `work-orders/public/...`) уникає колізії
 * з `@Controller('work-orders')` + `@Get(':id')` у захищеному контролері: інакше
 * NestJS міг би замапити `GET /work-orders/public/:token` на `:id`-handler з ParseUUIDPipe
 * → 400 на легітимний токен.
 *
 * Жорсткіший throttle (20 req/min) → захист від brute-force shareToken-ів.
 * Сам токен — 128 біт (randomBytes(16).toString('hex')), вгадати неможливо,
 * але throttle прибирає automated probing з логів і Sentry-шум.
 */
@ApiTags('Work Orders (Public)')
@Controller('public/work-orders')
export class WorkOrdersPublicController {
  constructor(private readonly service: WorkOrdersService) {}

  @Get(':token')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiOperation({ summary: 'Публічний перегляд кошторису за share-токеном' })
  getPublicEstimate(@Param('token') token: string) {
    return this.service.findByShareToken(token);
  }
}
