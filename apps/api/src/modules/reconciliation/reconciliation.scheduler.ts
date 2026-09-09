import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { forEachActiveOrg } from '../../common/scheduler/for-each-active-org';

/**
 * A3 — реєструє щоденний per-org reconciliation-job (звірка інваріантів stock/balance/paidAmount).
 * Дзеркалить IntegrationLogPurgeScheduler: cursor-пагінація активних орг, jobId-дедуп, Kyiv-TZ.
 * О 02:00 (нічний off-peak, до purge-джобів). Тільки читає + логує drift — нічого не пише.
 */
@Injectable()
export class ReconciliationScheduler implements OnModuleInit {
  private readonly logger = new Logger(ReconciliationScheduler.name);

  constructor(
    @InjectQueue('reconciliation') private readonly queue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const total = await forEachActiveOrg(
      this.prisma,
      async orgIds => {
        await Promise.all(
          orgIds.map(orgId =>
            this.queue.add(
              'reconcile',
              { orgId },
              {
                repeat: { pattern: '0 2 * * *', tz: 'Europe/Kyiv' },
                attempts: 3,
                backoff: { type: 'exponential', delay: 60_000 },
                jobId: `reconciliation-${orgId}`,
              },
            ),
          ),
        );
      },
      { logger: this.logger },
    );
    this.logger.log(`Reconciliation CRON зареєстровано для ${total} організацій`);
  }
}
