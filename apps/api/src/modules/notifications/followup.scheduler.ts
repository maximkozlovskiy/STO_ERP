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

    // Fires at 09:00 Kyiv time (BullMQ respects DST via tz: 'Europe/Kyiv')
    const orgs = await this.prisma.organisation.findMany({
      select: { orgId: true },
      take: 1000,
    });

    if (orgs.length >= 1000) {
      this.logger.warn('FollowUp scheduler: можливо не всі організації охоплені, потрібна пагінація');
    }

    for (const org of orgs) {
      await this.followUpQueue.add(
        'send-reminders',
        { orgId: org.orgId },
        {
          repeat: { cron: '0 9 * * *', tz: 'Europe/Kyiv' },
          attempts: 10,
          backoff: { type: 'exponential', delay: 60_000 },
          jobId: `followup-${org.orgId}`,
          removeOnComplete: true,
        },
      );
    }

    this.logger.log(`FollowUp CRON зареєстровано для ${orgs.length} організацій`);
  }
}
