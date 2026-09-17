import { Controller, Get, Inject, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { FilesService } from '../modules/files/files.service';

@ApiTags('health')
// VERSION_NEUTRAL: URL лишається /api/health/* (не /api/v1/health) — docker healthcheck,
// installer Update.ps1 та e2e-smoke б'ють /api/health/live; версіонування їх НЕ ламає.
@Controller({ path: 'health', version: VERSION_NEUTRAL })
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue('sms') private readonly smsQueue: Queue,
  ) {}

  /**
   * D1: LIVENESS — процес живий, БЕЗ перевірки залежностей. Container-healthcheck (docker-compose)
   * б'є саме сюди: блимання Redis/MinIO НЕ має валити контейнер (інакше web+caddy cascade). Завжди 200.
   */
  @Get('live')
  @ApiOperation({ summary: 'Liveness — процес живий (без залежностей)' })
  live() {
    return { status: 'ok', uptime: process.uptime() };
  }

  /**
   * D1: READINESS — готовність приймати трафік: DB + Redis + MinIO + черга. Для оркестрації/
   * моніторингу (не для container-healthcheck). 503-семантика через поле status='degraded' коли
   * будь-яка залежність впала (HTTP лишається 200 — клієнт читає поле, дзеркалить наявний /health).
   */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness — DB + Redis + MinIO + черга' })
  async ready() {
    const [dbRes, redisRes, minioRes, queueRes] = await Promise.allSettled([
      this.prisma.$queryRaw`SELECT 1`,
      this.redis.ping(),
      this.files.healthCheck(),
      this.smsQueue.getWaitingCount(),
    ]);
    const db = dbRes.status === 'fulfilled' ? 'ok' : 'error';
    const redis = redisRes.status === 'fulfilled' && redisRes.value === 'PONG' ? 'ok' : 'error';
    const minio = minioRes.status === 'fulfilled' && minioRes.value === true ? 'ok' : 'error';
    const queue = queueRes.status === 'fulfilled' ? 'ok' : 'error';
    const allOk = db === 'ok' && redis === 'ok' && minio === 'ok' && queue === 'ok';
    return {
      status: allOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services: {
        database: { status: db },
        redis: { status: redis },
        minio: { status: minio },
        queue: {
          status: queue,
          waiting: queueRes.status === 'fulfilled' ? queueRes.value : -1,
        },
      },
    };
  }

  @Get()
  @ApiOperation({ summary: 'Детальний стан сервісу (=readiness)' })
  async check() {
    // Зберігаємо історичний детальний endpoint; тепер він = /ready (DB+Redis+MinIO+черга).
    return this.ready();
  }
}
