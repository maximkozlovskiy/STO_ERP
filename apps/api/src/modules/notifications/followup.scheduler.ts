import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class FollowUpScheduler implements OnModuleInit {
  private readonly logger = new Logger(FollowUpScheduler.name);

  constructor(
    @InjectQueue('followup') private readonly followUpQueue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    // Remove existing repeating jobs to avoid duplicates on restart
    const existingJobs = await this.followUpQueue.getRepeatableJobs();
    for (const job of existingJobs) {
      await this.followUpQueue.removeRepeatableByKey(job.key);
    }

    // Schedule per-org follow-up jobs using BullMQ repeat
    // Each org gets its own job scheduled at 09:00 Kyiv time (UTC+2/+3)
    // Since BullMQ cron runs in UTC, we use 07:00 UTC which is 09:00 UTC+2 (winter)
    // In summer (UTC+3) this fires at 10:00 local — acceptable trade-off without DST logic
    const orgs = await this.prisma.organisation.findMany({
      select: { orgId: true },
      take: 100,
    });

    for (const org of orgs) {
      await this.followUpQueue.add(
        'send-reminders',
        { orgId: org.orgId },
        {
          repeat: { cron: '0 7 * * *', tz: 'Europe/Kyiv' },
          attempts: 3,
          backoff: { type: 'exponential', delay: 60_000 },
          jobId: `followup-${org.orgId}`,
        },
      );
    }

    this.logger.log(`FollowUp CRON зареєстровано для ${orgs.length} організацій`);
  }
}
