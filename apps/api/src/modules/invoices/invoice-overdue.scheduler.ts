import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { forEachActiveOrg } from '../../common/scheduler/for-each-active-org';

/**
 * Реєструє щоденний repeatable-job позначення прострочених рахунків (OVERDUE).
 * Дзеркалить FollowUpScheduler: per-org BullMQ repeat, jobId-дедуп, Kyiv-TZ.
 * Спрацьовує о 06:00 Kyiv (рано, до робочого дня — щоб дашборд/звіти вже бачили прострочку).
 */
@Injectable()
export class InvoiceOverdueScheduler implements OnModuleInit {
  private readonly logger = new Logger(InvoiceOverdueScheduler.name);

  constructor(
    @InjectQueue('invoice-overdue') private readonly overdueQueue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    // Cursor-пагінація всіх активних орг (Bug #107). BullMQ дедуплікує repeatable
    // за jobId → add() ідемпотентний на рестарті.
    const total = await forEachActiveOrg(
      this.prisma,
      async orgIds => {
        await Promise.all(
          orgIds.map(orgId =>
            this.overdueQueue.add(
              'mark-overdue',
              { orgId },
              {
                repeat: { pattern: '0 6 * * *', tz: 'Europe/Kyiv' },
                attempts: 5,
                backoff: { type: 'exponential', delay: 60_000 },
                jobId: `overdue-${orgId}`,
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
    this.logger.log(`Overdue CRON зареєстровано для ${total} організацій`);
  }
}
