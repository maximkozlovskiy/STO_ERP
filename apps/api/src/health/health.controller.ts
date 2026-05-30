import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('health')
@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('sms') private readonly smsQueue: Queue,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Детальний стан сервісу' })
  async check() {
    const results = await Promise.allSettled([
      this.prisma.$queryRaw`SELECT 1`,
      this.smsQueue.getWaitingCount(),
    ]);

    const db = results[0].status === 'fulfilled' ? 'ok' : 'error';
    const queueWaiting =
      results[1].status === 'fulfilled' ? (results[1] as PromiseFulfilledResult<number>).value : -1;

    return {
      status: db === 'ok' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services: {
        database: { status: db },
        queue: { status: 'ok', waiting: queueWaiting },
      },
    };
  }
}
