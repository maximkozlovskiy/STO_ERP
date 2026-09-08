import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';

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
    const orgs = await this.prisma.organisation.findMany({
      where: { deletedAt: null },
      select: { id: true },
      take: 1000,
    });
    if (orgs.length >= 1000) {
      this.logger.warn(
        'Overdue scheduler: досягнуто ліміту 1000 організацій — можливо не всі охоплені (потрібна пагінація)',
      );
    }

    // BullMQ дедуплікує repeatable за jobId → add() ідемпотентний на рестарті.
    await Promise.all(
      orgs.map(org =>
        this.overdueQueue.add(
          'mark-overdue',
          { orgId: org.id },
          {
            repeat: { pattern: '0 6 * * *', tz: 'Europe/Kyiv' },
            attempts: 5,
            backoff: { type: 'exponential', delay: 60_000 },
            jobId: `overdue-${org.id}`,
            removeOnComplete: true,
          },
        ),
      ),
    );
    this.logger.log(`Overdue CRON зареєстровано для ${orgs.length} організацій`);
  }
}
