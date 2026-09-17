import { Processor, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { runUnscoped } from '../tenant/tenant-context';
import { DeadLetterWorkerHost } from '../../modules/dead-letter/dead-letter-worker-host';
import { DeadLetterService } from '../../modules/dead-letter/dead-letter.service';

/**
 * A1.3 — видаляє протерміновані IdempotencyKey (expiresAt < now). Глобальний hard-delete: рядки
 * server-local infra (не sync, не soft-delete), а вікно дедуплікації минуло → рядок більше не
 * потрібен. Індекс @@index([expiresAt]) робить видалення дешевим.
 */
@Injectable()
@Processor('idempotency-purge', { concurrency: 1 })
export class IdempotencyPurgeProcessor extends DeadLetterWorkerHost {
  private readonly logger = new Logger(IdempotencyPurgeProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    deadLetter: DeadLetterService,
  ) {
    super(deadLetter);
  }

  async process(_job: Job): Promise<void> {
    return runUnscoped(async () => {
      const { count } = await this.prisma.idempotencyKey.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      if (count > 0) {
        this.logger.log(`IdempotencyKey purge: видалено ${count} протермінованих`);
      }
    });
  }

  // Централізований DLQ: терминальний провал → DeadLetterJob (аудит стеку, backend #2).
  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): Promise<void> {
    return this.deadLetterOnFailed(job, err);
  }
}
