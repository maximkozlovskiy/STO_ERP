import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class FollowUpScheduler implements OnModuleInit {
  private readonly logger = new Logger(FollowUpScheduler.name);

  constructor(
    @InjectQueue('followup') private readonly followUpQueue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    // Only active (non-soft-deleted) organisations need CRON.
    // ADR-001: on-prem installer = 1 org per deployment. Multi-tenant cloud
    // would require cursor pagination here (Bug #107).
    const orgs = await this.prisma.organisation.findMany({
      where: { deletedAt: null },
      select: { id: true },
      take: 1000,
    });

    if (orgs.length >= 1000) {
      this.logger.warn(
        'FollowUp scheduler: досягнуто ліміту 1000 організацій, можливо не всі охоплені — потрібна пагінація',
      );
    }

    // BullMQ deduplicates repeatable jobs by `jobId`, so add() is idempotent —
    // no need to delete-and-recreate on every restart (Bug #108).
    // Fires at 09:00 Kyiv time (BullMQ respects DST via tz: 'Europe/Kyiv').
    // Parallel fan-out: queue.add робить незалежний Redis RTT на кожен org. Sequential
    // await серіалізував їх N×(Redis RTT). Promise.all collapses у concurrent batch —
    // Bull pipelines через ioredis multi/exec. На on-prem (1 org) — no-op; для cloud
    // (N orgs) — startup ledger.
    await Promise.all(
      orgs.map(org =>
        this.followUpQueue.add(
          'send-reminders',
          { orgId: org.id },
          {
            repeat: { pattern: '0 9 * * *', tz: 'Europe/Kyiv' },
            attempts: 10,
            backoff: { type: 'exponential', delay: 60_000 },
            jobId: `followup-${org.id}`,
            removeOnComplete: true,
          },
        ),
      ),
    );

    this.logger.log(`FollowUp CRON зареєстровано для ${orgs.length} організацій`);
  }
}
