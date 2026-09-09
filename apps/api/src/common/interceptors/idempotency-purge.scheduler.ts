import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

/**
 * A1.3 — щоденний purge протермінованих IdempotencyKey. На відміну від integration-log-purge
 * (per-org retention), тут вікно фіксоване (expiresAt на кожному рядку) і однакове для всіх орг,
 * тож — ОДИН глобальний repeatable job (без forEachActiveOrg): `deleteMany expiresAt<now`.
 * О 04:00 Kyiv (off-peak). jobId-дедуп + DEFAULT_JOB_OPTS (removeOnFail cap) з реєстрації черги.
 */
@Injectable()
export class IdempotencyPurgeScheduler implements OnModuleInit {
  private readonly logger = new Logger(IdempotencyPurgeScheduler.name);

  constructor(@InjectQueue('idempotency-purge') private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.add(
      'purge',
      {},
      {
        repeat: { pattern: '0 4 * * *', tz: 'Europe/Kyiv' },
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        jobId: 'idempotency-purge',
      },
    );
    this.logger.log('IdempotencyKey purge CRON зареєстровано (глобальний, 04:00 Kyiv)');
  }
}
