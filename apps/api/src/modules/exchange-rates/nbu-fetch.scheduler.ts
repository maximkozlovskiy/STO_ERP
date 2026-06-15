import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';

const MAX_ORGS_PER_SCHEDULER_RUN = 1000;

@Injectable()
export class NbuFetchScheduler implements OnModuleInit {
  private readonly logger = new Logger(NbuFetchScheduler.name);

  constructor(
    @InjectQueue('nbu-fetch') private readonly queue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Single batch: orgs + their settings (N+1 → 2 queries).
    // For 1000 cloud orgs this avoids 1000 sequential findUnique reads
    // during bootstrap that gated the entire scheduler init.
    const [orgs, allSettings] = await Promise.all([
      this.prisma.organisation.findMany({
        where: { deletedAt: null },
        select: { id: true },
        take: MAX_ORGS_PER_SCHEDULER_RUN,
      }),
      this.prisma.organisationSettings.findMany({
        select: { orgId: true, nbuFetchHour: true },
        take: MAX_ORGS_PER_SCHEDULER_RUN,
      }),
    ]);
    const hourByOrg = new Map(allSettings.map(s => [s.orgId, s.nbuFetchHour ?? 12]));

    await Promise.all(
      orgs.map(org => this.enqueueRepeatableForOrg(org.id, hourByOrg.get(org.id) ?? 12)),
    );
    this.logger.log(`NBU fetch CRON зареєстровано для ${orgs.length} організацій`);
  }

  async scheduleForOrg(orgId: string): Promise<void> {
    const settings = await this.prisma.organisationSettings.findUnique({
      where: { orgId },
      select: { nbuFetchHour: true },
    });
    await this.enqueueRepeatableForOrg(orgId, settings?.nbuFetchHour ?? 12);
  }

  // Extracted to allow bulk bootstrap to skip per-org settings fetch
  // (settings prefetched in one findMany).
  private async enqueueRepeatableForOrg(orgId: string, hour: number): Promise<void> {
    await this.queue.add(
      'fetch-rates',
      { orgId },
      {
        repeat: { pattern: `0 ${hour} * * *`, tz: 'Europe/Kyiv' },
        attempts: 5,
        backoff: { type: 'exponential', delay: 300_000 },
        jobId: `nbu-fetch-${orgId}`,
        removeOnComplete: true,
      },
    );
  }

  async rescheduleForOrg(orgId: string, newHour: number): Promise<void> {
    // Remove old repeatable job (if any) by key — key contains jobId as suffix
    const repeatableJobs = await this.queue.getRepeatableJobs();
    const existing = repeatableJobs.find(j => j.key.includes(`nbu-fetch-${orgId}`));
    if (existing) {
      await this.queue.removeRepeatableByKey(existing.key);
    }
    await this.queue.add(
      'fetch-rates',
      { orgId },
      {
        repeat: { pattern: `0 ${newHour} * * *`, tz: 'Europe/Kyiv' },
        attempts: 5,
        backoff: { type: 'exponential', delay: 300_000 },
        jobId: `nbu-fetch-${orgId}`,
        removeOnComplete: true,
      },
    );
    this.logger.log(`NBU fetch CRON перепланований org=${orgId} на ${newHour}:00`);
  }

  async enqueueImmediate(orgId: string): Promise<{ queued: true }> {
    await this.queue.add(
      'fetch-rates',
      { orgId },
      {
        attempts: 3,
        backoff: { type: 'fixed', delay: 5_000 },
        removeOnComplete: true,
      },
    );
    this.logger.log(`NBU fetch поставлено в чергу (негайно) org=${orgId}`);
    return { queued: true };
  }
}
