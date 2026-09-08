import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { forEachActiveOrg } from '../../common/scheduler/for-each-active-org';

/**
 * Реєструє щоденний per-org purge-job для IntegrationLog (append-only таблиця). Дзеркалить
 * NbuFetchScheduler: cursor-пагінація активних орг, jobId-дедуп, Kyiv-TZ. Спрацьовує о 03:00
 * (нічний off-peak). Скільки зберігати — OrganisationSettings.integrationLogRetentionDays (у processor).
 */
@Injectable()
export class IntegrationLogPurgeScheduler implements OnModuleInit {
  private readonly logger = new Logger(IntegrationLogPurgeScheduler.name);

  constructor(
    @InjectQueue('integration-log-purge') private readonly queue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const total = await forEachActiveOrg(
      this.prisma,
      async orgIds => {
        await Promise.all(
          orgIds.map(orgId =>
            this.queue.add(
              'purge',
              { orgId },
              {
                repeat: { pattern: '0 3 * * *', tz: 'Europe/Kyiv' },
                attempts: 3,
                backoff: { type: 'exponential', delay: 60_000 },
                jobId: `integration-log-purge-${orgId}`,
                removeOnComplete: true,
                // F1: repeatable — cap failed-set (інакше росте безмежно у Redis).
                removeOnFail: 200,
              },
            ),
          ),
        );
      },
      { logger: this.logger },
    );
    this.logger.log(`IntegrationLog purge CRON зареєстровано для ${total} організацій`);
  }
}
