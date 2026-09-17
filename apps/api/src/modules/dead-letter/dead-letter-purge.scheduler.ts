import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { forEachActiveOrg } from '../../common/scheduler/for-each-active-org';

/**
 * Реєструє щоденний per-org purge-job для RESOLVED DeadLetterJob. Дзеркалить
 * IntegrationLogPurgeScheduler: cursor-пагінація активних орг, jobId-дедуп, Kyiv-TZ. Спрацьовує о 04:00
 * (на годину пізніше за integration-log-purge о 03:00 — уникаємо overlap). Скільки зберігати —
 * OrganisationSettings.deadLetterRetentionDays (у processor).
 *
 * Адаптація 4: ОКРЕМИЙ null-org global job — org-agnostic рядки (orgId:null) мають свій sweep,
 * бо forEachActiveOrg покриває лише реальні org, а провали без org до жодної не належать.
 */
@Injectable()
export class DeadLetterPurgeScheduler implements OnModuleInit {
  private readonly logger = new Logger(DeadLetterPurgeScheduler.name);

  constructor(
    @InjectQueue('dead-letter-purge') private readonly queue: Queue,
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
                repeat: { pattern: '0 4 * * *', tz: 'Europe/Kyiv' },
                attempts: 3,
                backoff: { type: 'exponential', delay: 60_000 },
                jobId: `dead-letter-purge-${orgId}`,
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

    // Адаптація 4: один додатковий job для org-agnostic (orgId:null) рядків.
    await this.queue.add(
      'purge',
      { orgId: null },
      {
        repeat: { pattern: '0 4 * * *', tz: 'Europe/Kyiv' },
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        jobId: 'dead-letter-purge-global-null-org',
        removeOnComplete: true,
        removeOnFail: 200,
      },
    );

    this.logger.log(
      `DeadLetterJob purge CRON зареєстровано для ${total} організацій + 1 global null-org`,
    );
  }
}
