import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { runWithTenant } from '../../common/tenant/tenant-context';
import { TelegramBotService } from './telegram-bot.service';

/**
 * Тік опитування власного Telegram-бота організації (BR-AUT-041). Без dead-letter: збій мережі
 * тік не кидає, а запис у DLQ на кожен тік (кожні 3 с, поки СТО без інтернету) лише засмічував би
 * його. Конкурентність — кілька організацій одночасно; одну й ту саму організацію рятує
 * ідемпотентна обробка (`TelegramBotService.poll`).
 */
@Injectable()
// Ім'я черги — літерал: статичний сторож черг (payments.queue-retry-policy.spec) читає саме його.
@Processor('telegram-bot', { concurrency: 4 })
export class TelegramBotProcessor extends WorkerHost {
  constructor(private readonly bot: TelegramBotService) {
    super();
  }

  async process(job: Job<{ orgId: string }>): Promise<{ processed: number }> {
    const { orgId } = job.data;
    return runWithTenant({ orgId }, () => this.bot.poll(orgId));
  }
}
