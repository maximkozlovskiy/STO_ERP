import { Processor, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { runWithTenant, runUnscoped } from '../../common/tenant/tenant-context';
import { kyivToday, addDaysKyiv } from '../../common/utils/kyiv-date';
import { DeadLetterWorkerHost } from './dead-letter-worker-host';
import { DeadLetterService } from './dead-letter.service';

export interface PurgeJob {
  /** string → per-org purge (retention з OrganisationSettings). null → глобальний sweep org-agnostic рядків. */
  orgId: string | null;
}

const DEFAULT_RETENTION_DAYS = 180;
const MIN_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 730;

/**
 * Видаляє RESOLVED DeadLetterJob старші за OrganisationSettings.deadLetterRetentionDays
 * (clamp [7,730] — довше за integration-log через юридичну вагу фіскальних/legal провалів;
 * fallback 180). Дзеркалить integration-log-purge з 4 адаптаціями:
 *
 *  1. RESOLVED-ONLY: WHERE resolved:true. resolved=false (нерозв'язані фіскальні/legal провали) —
 *     ПОСТІЙНІ до ручного вирішення оператором, НІКОЛИ не видаляються автоматично.
 *  2. RETENTION [7,730] fallback 180 (per-org settings; null-org → DEFAULT).
 *  3. ORG-SCOPED vs GLOBAL null-org: job.data.orgId string → runWithTenant + per-org purge;
 *     job.data.orgId === null → runUnscoped + sweep рядків з orgId:null (org-agnostic провали).
 *     DeadLetterJob TENANT_EXEMPT → явний orgId-фільтр у where = ручне scoping (коректно).
 *
 * cutoff = Kyiv-північ (today − N днів) через @db.Date-семантику createdAt.
 */
@Injectable()
@Processor('dead-letter-purge', { concurrency: 1 })
export class DeadLetterPurgeProcessor extends DeadLetterWorkerHost {
  private readonly logger = new Logger(DeadLetterPurgeProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    deadLetter: DeadLetterService,
  ) {
    super(deadLetter);
  }

  async process(job: Job<PurgeJob>): Promise<void> {
    const { orgId } = job.data;

    // Адаптація 3b: null-org → глобальний sweep org-agnostic рядків (DEFAULT retention, без per-org settings).
    if (orgId === null) {
      return runUnscoped(async () => {
        const cutoff = addDaysKyiv(kyivToday(), -DEFAULT_RETENTION_DAYS);
        const { count } = await this.prisma.deadLetterJob.deleteMany({
          where: { orgId: null, resolved: true, createdAt: { lt: cutoff } },
        });
        if (count > 0) {
          this.logger.log(
            `DeadLetterJob purge org=null (global): видалено ${count} resolved (старші за ${DEFAULT_RETENTION_DAYS} дн.)`,
          );
        }
      });
    }

    // Адаптація 3a: per-org purge — retention з OrganisationSettings.
    return runWithTenant({ orgId }, async () => {
      const settings = await this.prisma.organisationSettings.findUnique({
        where: { orgId },
        select: { deadLetterRetentionDays: true },
      });
      const raw = Number(settings?.deadLetterRetentionDays ?? DEFAULT_RETENTION_DAYS);
      const days = Number.isFinite(raw)
        ? Math.min(Math.max(Math.trunc(raw), MIN_RETENTION_DAYS), MAX_RETENTION_DAYS)
        : DEFAULT_RETENTION_DAYS;

      const cutoff = addDaysKyiv(kyivToday(), -days);
      const { count } = await this.prisma.deadLetterJob.deleteMany({
        // Адаптація 1: resolved:true — НІКОЛИ не видаляємо нерозв'язані (постійні до ручного вирішення).
        where: { orgId, resolved: true, createdAt: { lt: cutoff } },
      });
      if (count > 0) {
        this.logger.log(
          `DeadLetterJob purge org=${orgId}: видалено ${count} resolved (старші за ${days} дн.)`,
        );
      }
    });
  }

  // Централізований DLQ: терминальний провал → DeadLetterJob (аудит стеку, backend #2).
  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): Promise<void> {
    return this.deadLetterOnFailed(job, err);
  }
}
