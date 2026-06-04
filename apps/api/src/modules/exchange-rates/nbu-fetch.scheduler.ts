import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class NbuFetchScheduler implements OnModuleInit {
  private readonly logger = new Logger(NbuFetchScheduler.name);

  constructor(
    @InjectQueue('nbu-fetch') private readonly queue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const orgs = await this.prisma.organisation.findMany({
      where: { deletedAt: null },
      select: { id: true },
      take: 1000,
    });

    await Promise.all(orgs.map(org => this.scheduleForOrg(org.id)));
    this.logger.log(`NBU fetch CRON зареєстровано для ${orgs.length} організацій`);
  }

  async scheduleForOrg(orgId: string): Promise<void> {
    const settings = await this.prisma.organisationSettings.findUnique({
      where: { orgId },
      select: { nbuFetchHour: true },
    });
    const hour = settings?.nbuFetchHour ?? 12;
    await this.queue.add(
      'fetch-rates',
      { orgId },
      {
        repeat: { cron: `0 ${hour} * * *`, tz: 'Europe/Kyiv' },
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
        repeat: { cron: `0 ${newHour} * * *`, tz: 'Europe/Kyiv' },
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
