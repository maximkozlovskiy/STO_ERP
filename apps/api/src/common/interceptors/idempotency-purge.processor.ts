import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * A1.3 — видаляє протерміновані IdempotencyKey (expiresAt < now). Глобальний hard-delete: рядки
 * server-local infra (не sync, не soft-delete), а вікно дедуплікації минуло → рядок більше не
 * потрібен. Індекс @@index([expiresAt]) робить видалення дешевим.
 */
@Injectable()
@Processor('idempotency-purge', { concurrency: 1 })
export class IdempotencyPurgeProcessor extends WorkerHost {
  private readonly logger = new Logger(IdempotencyPurgeProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(_job: Job): Promise<void> {
    const { count } = await this.prisma.idempotencyKey.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (count > 0) {
      this.logger.log(`IdempotencyKey purge: видалено ${count} протермінованих`);
    }
  }
}
