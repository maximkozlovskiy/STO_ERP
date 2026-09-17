import { WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { DeadLetterService } from './dead-letter.service';

/**
 * База для BullMQ-процесорів із централізованим dead-letter (аудит стеку, backend #2).
 *
 * Процесори extend-ять цей клас замість `WorkerHost` і додають ОДНОРЯДКОВИЙ decorated-handler:
 *
 *   @OnWorkerEvent('failed')
 *   onFailed(job: Job, err: Error) { return this.deadLetterOnFailed(job, err); }
 *
 * ЧОМУ не декоруємо у базі: `@OnWorkerEvent` @nestjs/bullmq сканує по прототипу; декоратор у базі
 * + override у підкласі (checkbox) дає неоднозначну реєстрацію. Явний per-processor handler, що
 * делегує у `deadLetterOnFailed`, тримає guard-логіку в ОДНОМУ місці без scan-ambiguity.
 *
 * ЧОМУ у процесі, а не QueueEvents: BullMQ 5 `QueueEvents.failed` несе лише {jobId, failedReason} —
 * без attemptsMade/opts/data, і out-of-band getJob може повернути null після removeOnFail:200
 * (job евіктнуто) → втрата capture. Тут `Job` повний, синхронно, без гонки.
 */
export abstract class DeadLetterWorkerHost extends WorkerHost {
  protected constructor(protected readonly deadLetter: DeadLetterService) {
    super();
  }

  /**
   * Викликається з @OnWorkerEvent('failed') підкласу. Терминальний гейт (дзеркалить
   * checkbox.processor): пишемо у DLQ ЛИШЕ коли вичерпано ВСІ спроби — не на проміжних провалах.
   * `this.worker.name` = ім'я черги (без per-processor wiring).
   */
  protected async deadLetterOnFailed(job: Job, err: Error): Promise<void> {
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) return; // ще будуть ретраї — не терминал
    await this.deadLetter.capture(job, err, this.worker.name);
  }
}
