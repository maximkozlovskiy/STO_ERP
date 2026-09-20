import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { forEachActiveOrg } from '../../common/scheduler/for-each-active-org';

// Інтервал pull виписки (хв). clamp [MIN, MAX]; DEFAULT якщо не налаштовано.
export const BANK_PULL_MIN_MINUTES = 15;
export const BANK_PULL_MAX_MINUTES = 1440;
export const BANK_PULL_DEFAULT_MINUTES = 60;

const clampInterval = (m: number): number =>
  Math.min(Math.max(Math.round(m), BANK_PULL_MIN_MINUTES), BANK_PULL_MAX_MINUTES);

/**
 * Планувальник auto-pull банк-виписки (Privat24). При старті реєструє repeatable-job на кожну
 * активну орг з інтервалом OrganisationSettings.bankStatementPollIntervalMinutes. Дзеркалить
 * NbuFetchScheduler (cursor-пагінація орг + per-batch settings-prefetch, без N+1).
 *
 * ЛЕАФ-модуль (bank-statement-pull.module) тримає лише цей scheduler + чергу — SettingsModule
 * імпортує саме леаф (НЕ важкий BankStatementsModule, що тягне PaymentsModule) для reschedule-хука,
 * уникаючи циклу залежностей.
 */
@Injectable()
export class BankStatementPullScheduler implements OnModuleInit {
  private readonly logger = new Logger(BankStatementPullScheduler.name);

  constructor(
    @InjectQueue('bank-statement-polling') private readonly queue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Cursor-пагінація всіх активних орг (Bug #107). Per-batch settings-prefetch одним findMany
    // на батч замість N sequential findUnique.
    const total = await forEachActiveOrg(this.prisma, async orgIds => {
      const settings = await this.prisma.organisationSettings.findMany({
        where: { orgId: { in: orgIds } },
        select: { orgId: true, bankStatementPollIntervalMinutes: true },
      });
      const byOrg = new Map(
        settings.map(s => [
          s.orgId,
          s.bankStatementPollIntervalMinutes ?? BANK_PULL_DEFAULT_MINUTES,
        ]),
      );
      await Promise.all(
        orgIds.map(orgId =>
          this.enqueueRepeatableForOrg(orgId, byOrg.get(orgId) ?? BANK_PULL_DEFAULT_MINUTES),
        ),
      );
    });
    this.logger.log(`Bank-statement pull CRON зареєстровано для ${total} організацій`);
  }

  private async enqueueRepeatableForOrg(orgId: string, minutes: number): Promise<void> {
    await this.queue.add(
      'pull',
      { orgId },
      {
        repeat: { every: clampInterval(minutes) * 60_000, tz: 'Europe/Kyiv' },
        attempts: 5,
        backoff: { type: 'exponential', delay: 300_000 },
        jobId: `bank-pull-${orgId}`,
        removeOnComplete: true,
        // F1: repeatable — cap failed-set (інакше росте безмежно у Redis).
        removeOnFail: 200,
      },
    );
  }

  /** Перепланувати repeatable-job орг на новий інтервал (виклик із SettingsService при зміні). */
  async rescheduleForOrg(orgId: string, newMinutes: number): Promise<void> {
    const repeatableJobs = await this.queue.getRepeatableJobs();
    const existing = repeatableJobs.find(j => j.key.includes(`bank-pull-${orgId}`));
    if (existing) {
      await this.queue.removeRepeatableByKey(existing.key);
    }
    await this.enqueueRepeatableForOrg(orgId, newMinutes);
    this.logger.log(
      `Bank-statement pull CRON перепланований org=${orgId} на ${clampInterval(newMinutes)} хв`,
    );
  }

  /** Поставити pull негайно (кнопка «Підтягнути зараз»). jobId-дедуп проти спаму кнопки. */
  async enqueueImmediate(orgId: string): Promise<{ queued: true }> {
    await this.queue.add(
      'pull',
      { orgId },
      {
        attempts: 3,
        backoff: { type: 'fixed', delay: 5_000 },
        // Окремий jobId від repeatable (`bank-pull-<org>`) — щоб не конфліктувати з cron-записом.
        jobId: `bank-pull-now-${orgId}`,
        removeOnComplete: true,
        removeOnFail: 200,
      },
    );
    this.logger.log(`Bank-statement pull поставлено в чергу (негайно) org=${orgId}`);
    return { queued: true };
  }
}
