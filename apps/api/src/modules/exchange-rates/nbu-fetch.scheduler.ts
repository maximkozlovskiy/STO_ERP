import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { forEachActiveOrg } from '../../common/scheduler/for-each-active-org';

@Injectable()
export class NbuFetchScheduler implements OnModuleInit {
  private readonly logger = new Logger(NbuFetchScheduler.name);

  constructor(
    @InjectQueue('nbu-fetch') private readonly queue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Cursor-пагінація всіх активних орг (Bug #107). Per-batch settings-prefetch
    // (nbuFetchHour) одним findMany на батч замість N sequential findUnique —
    // без завантаження всіх settings у пам'ять одночасно.
    const total = await forEachActiveOrg(this.prisma, async orgIds => {
      const settings = await this.prisma.organisationSettings.findMany({
        where: { orgId: { in: orgIds } },
        select: { orgId: true, nbuFetchHour: true },
      });
      const hourByOrg = new Map(settings.map(s => [s.orgId, s.nbuFetchHour ?? 12]));
      await Promise.all(
        orgIds.map(orgId => this.enqueueRepeatableForOrg(orgId, hourByOrg.get(orgId) ?? 12)),
      );
    });
    this.logger.log(`NBU fetch CRON зареєстровано для ${total} організацій`);
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
