import { Processor, OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DomainEvent } from '@prisma/client';
import type { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { runUnscoped, runWithTenant } from '../../common/tenant/tenant-context';
import { DOMAIN_EVENT_HANDLERS, type DomainEventHandler } from './domain-event-handler';

/** Скільки подій бере один прохід job-а (кожні ~10 с). */
export const AUTOMATION_EVENTS_BATCH = 100;
/** Пауза перед повтором після першого збою; далі подвоюється до стелі. */
export const AUTOMATION_RETRY_BASE_MS = 10_000;
export const AUTOMATION_RETRY_MAX_MS = 3_600_000;
const LAST_ERROR_MAX = 1000;

/** Пауза перед наступною спробою події, яка вже `attempts` разів не оброблялась (BR-AUT-061). */
export function retryDelayMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(AUTOMATION_RETRY_BASE_MS * 2 ** (attempts - 1), AUTOMATION_RETRY_MAX_MS);
}

/**
 * BR-AUT-061: обробка outbox `DomainEvent`. Повторюваний job черги `automation-events` бере пачку
 * необроблених подій за `occurredAt`, передає кожну обробникам (`DOMAIN_EVENT_HANDLERS`) і
 * позначає `processedAt`. Збій — `attempts`+1 і `lastError`; подія лишається необробленою, наступна
 * спроба — після `retryDelayMs(attempts)` від останньої (`updatedAt`). Зовнішніх викликів тут немає.
 *
 * Нові події (`attempts = 0`) і повтори вибираються окремо: пачка подій, що падають, не відсуває
 * свіжі. Повтор, ще не дочекавшись паузи, пропускається до наступного проходу.
 *
 * Без dead-letter: подія не губиться (вона в БД), а збій усього проходу (БД недоступна) повторить
 * наступний тік через ~10 с — запис у DLQ на кожен тік лише засмічував би його.
 */
@Injectable()
// Ім'я черги — літерал: статичний сторож черг (payments.queue-retry-policy.spec) читає саме його.
@Processor('automation-events', { concurrency: 1 })
export class AutomationEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(AutomationEventsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DOMAIN_EVENT_HANDLERS) private readonly handlers: readonly DomainEventHandler[],
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    await this.processBatch(new Date());
  }

  /** Один прохід; повертає кількість оброблених і збійних подій (для тестів і логу). */
  async processBatch(now: Date): Promise<{ processed: number; failed: number }> {
    const events = await this.selectDue(now);
    let processed = 0;
    let failed = 0;
    for (const event of events) {
      if (await this.processOne(event)) processed++;
      else failed++;
    }
    if (failed > 0) this.logger.warn(`automation-events: оброблено ${processed}, збій ${failed}`);
    return { processed, failed };
  }

  /**
   * Вибірка крос-організаційна (job один на всі організації) — `runUnscoped`; кожна подія далі
   * обробляється й позначається в tenant-scope своєї організації.
   */
  private async selectDue(now: Date): Promise<DomainEvent[]> {
    const [fresh, retries] = await runUnscoped(async () =>
      Promise.all([
        this.prisma.domainEvent.findMany({
          where: { processedAt: null, deletedAt: null, attempts: 0 },
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
          take: AUTOMATION_EVENTS_BATCH,
        }),
        this.prisma.domainEvent.findMany({
          where: { processedAt: null, deletedAt: null, attempts: { gt: 0 } },
          orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
          take: AUTOMATION_EVENTS_BATCH,
        }),
      ]),
    );
    const dueRetries = retries.filter(
      e => e.updatedAt.getTime() + retryDelayMs(e.attempts) <= now.getTime(),
    );
    return [...fresh, ...dueRetries].sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id),
    );
  }

  private async processOne(event: DomainEvent): Promise<boolean> {
    return runWithTenant({ orgId: event.orgId }, async () => {
      try {
        for (const handler of this.handlers) await handler.handle(event);
        await this.prisma.domainEvent.updateMany({
          where: { id: event.id, orgId: event.orgId, processedAt: null },
          data: { processedAt: new Date(), lastError: null },
        });
        return true;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await this.prisma.domainEvent.updateMany({
          where: { id: event.id, orgId: event.orgId, processedAt: null },
          data: { attempts: { increment: 1 }, lastError: message.slice(0, LAST_ERROR_MAX) },
        });
        return false;
      }
    });
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): void {
    this.logger.warn(`automation-events job ${job.id ?? '?'} не виконано: ${err.message}`);
  }
}
