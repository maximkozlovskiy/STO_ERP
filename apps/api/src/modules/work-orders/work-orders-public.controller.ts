import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiProduces } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply } from 'fastify';
import { WorkOrdersService } from './work-orders.service';
import { EstimateExportService } from './work-orders-export.service';

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
  constructor(
    private readonly service: WorkOrdersService,
    private readonly exportService: EstimateExportService,
  ) {}

  @Get(':token')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiOperation({ summary: 'Публічний перегляд кошторису за share-токеном' })
  getPublicEstimate(@Param('token') token: string) {
    return this.service.findByShareToken(token);
  }

  // Specific routes before :token to avoid Fastify route collision
  @Get(':token/export/xlsx')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Завантажити кошторис у форматі XLSX' })
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async exportXlsx(@Param('token') token: string, @Res() reply: FastifyReply) {
    const { buffer, filename } = await this.exportService.generateXlsx(token);
    const encoded = encodeURIComponent(filename);
    void reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encoded}`)
      .header('Content-Length', buffer.length)
      .send(buffer);
  }

  @Get(':token/export/docx')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Завантажити кошторис у форматі DOCX' })
  @ApiProduces('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  async exportDocx(@Param('token') token: string, @Res() reply: FastifyReply) {
    const { buffer, filename } = await this.exportService.generateDocx(token);
    const encoded = encodeURIComponent(filename);
    void reply
      .header(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      )
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encoded}`)
      .header('Content-Length', buffer.length)
      .send(buffer);
  }
}
