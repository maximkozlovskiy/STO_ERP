import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { runWithTenant } from '../../common/tenant/tenant-context';
import { kyivToday, addDaysKyiv } from '../../common/utils/kyiv-date';

export interface PurgeJob {
  orgId: string;
}

const DEFAULT_RETENTION_DAYS = 30;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 365;

/**
 * Видаляє IntegrationLog старші за OrganisationSettings.integrationLogRetentionDays (clamp [1,365],
 * fallback 30). ORGID-SCOPED hard delete (append-only таблиця → soft-delete не застосовується;
 * інші org НЕ зачіпаються). cutoff = Kyiv-північ (today − N днів) через @db.Date-семантику createdAt.
 */
@Injectable()
@Processor('integration-log-purge', { concurrency: 1 })
export class IntegrationLogPurgeProcessor extends WorkerHost {
  private readonly logger = new Logger(IntegrationLogPurgeProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<PurgeJob>): Promise<void> {
    return runWithTenant({ orgId: job.data.orgId }, async () => {
      const { orgId } = job.data;
      const settings = await this.prisma.organisationSettings.findUnique({
        where: { orgId },
        select: { integrationLogRetentionDays: true },
      });
      const raw = Number(settings?.integrationLogRetentionDays ?? DEFAULT_RETENTION_DAYS);
      const days = Number.isFinite(raw)
        ? Math.min(Math.max(Math.trunc(raw), MIN_RETENTION_DAYS), MAX_RETENTION_DAYS)
        : DEFAULT_RETENTION_DAYS;

      const cutoff = addDaysKyiv(kyivToday(), -days);
      const { count } = await this.prisma.integrationLog.deleteMany({
        where: { orgId, createdAt: { lt: cutoff } },
      });
      if (count > 0) {
        this.logger.log(
          `IntegrationLog purge org=${orgId}: видалено ${count} (старші за ${days} дн.)`,
        );
      }
    });
  }
}
