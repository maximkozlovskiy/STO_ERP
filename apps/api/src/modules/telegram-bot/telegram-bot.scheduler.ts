import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { runUnscoped } from '../../common/tenant/tenant-context';

/** Як часто тік опитує `getUpdates` (коротке опитування, BR-AUT-041). */
export const TELEGRAM_POLL_EVERY_MS = 3_000;
const KEY_PREFIX = 'telegram-poll-';

/** Ключ повторюваного job-а опитування організації — один на org, дедуп між рестартами. */
export const telegramPollKey = (orgId: string): string => `${KEY_PREFIX}${orgId}`;

/**
 * Повторюваний job опитування власного Telegram-бота — по одному на організацію з підключеним
 * ботом (BR-AUT-040, 041). Ставиться при підключенні, знімається при відключенні; на старті api —
 * для всіх організацій із токеном, а «осиротілі» (бота відключено, поки api не працював) знімаються.
 * Збій старту (Redis недоступний) не зупиняє api: job-и поставить наступний старт чи підключення.
 */
@Injectable()
export class TelegramBotScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(TelegramBotScheduler.name);

  constructor(
    @InjectQueue('telegram-bot') private readonly queue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      // A1: крос-організаційна вибірка — явно поза tenant-scope.
      const rows = await runUnscoped(() =>
        this.prisma.organisationSettings.findMany({
          where: { telegramBotToken: { not: null }, org: { deletedAt: null } },
          select: { orgId: true },
          take: 10_000,
        }),
      );
      const connected = new Set(rows.map(r => r.orgId));
      for (const job of await this.queue.getRepeatableJobs()) {
        const orgId = job.key.startsWith(KEY_PREFIX) ? job.key.slice(KEY_PREFIX.length) : null;
        if (orgId && !connected.has(orgId)) await this.queue.removeRepeatableByKey(job.key);
      }
      for (const orgId of connected) await this.start(orgId);
      if (connected.size > 0) {
        this.logger.log(`Telegram-бот: опитування для ${connected.size} організацій`);
      }
    } catch (e: unknown) {
      this.logger.warn(
        `Telegram-бот: опитування не поставлено — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async start(orgId: string): Promise<void> {
    await this.queue.add(
      'poll',
      { orgId },
      {
        repeat: { every: TELEGRAM_POLL_EVERY_MS, key: telegramPollKey(orgId) },
        // Мережеві збої тік не кидає (тихо завершується, наступний тік пробує знову); повтор job-а
        // — лише для збою БД. Літерал — його читає статичний сторож черг.
        attempts: 10,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: true,
        removeOnFail: 200,
      },
    );
  }

  async stop(orgId: string): Promise<void> {
    await this.queue.removeRepeatableByKey(telegramPollKey(orgId));
  }
}
