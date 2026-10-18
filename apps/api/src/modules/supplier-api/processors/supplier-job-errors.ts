import { HttpException } from '@nestjs/common';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { isSupplierError, SupplierRateLimitError } from '../http/supplier-errors';

/** Текст помилки для рядка в БД: без стеку, обрізаний. */
export function errorText(e: unknown, max = 500): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.slice(0, max);
}

/** Чи ця спроба — остання (BullMQ рахує attemptsMade ДО поточної спроби). */
export function isLastAttempt(job: Pick<Job, 'attemptsMade' | 'opts'>): boolean {
  return job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
}

/** Приблизний час наступної спроби за експоненційним backoff (для «повтор о HH:MM» у UI). */
export function nextRetryAt(job: Pick<Job, 'attemptsMade' | 'opts'>, now = Date.now()): Date {
  const backoff = job.opts.backoff;
  const base = typeof backoff === 'object' && backoff?.delay ? backoff.delay : 30_000;
  return new Date(now + base * 2 ** job.attemptsMade);
}

export interface SupplierJobErrorHooks {
  /** Повтору не буде: записати в доменний рядок FAILED з причиною. */
  onFinal(message: string): Promise<void>;
  /** Буде повтор: записати RETRYING і час наступної спроби. */
  onRetry?(message: string, at: Date): Promise<void>;
}

/**
 * Єдина обробка помилки задачі до API постачальника (BR-SCON-006, 007):
 *  - ліміт → задача відкладається до скидання квоти (`moveToDelayed` + `DelayedError`), спроба
 *    не витрачається;
 *  - помилка, яку повтор не виправить (авторизація, протокол, наша валідація) → FAILED +
 *    `UnrecoverableError` (BullMQ не повторює);
 *  - решта → повтор за backoff черги; на останній спробі — FAILED.
 * Завжди кидає — обробник лише делегує сюди з `catch`.
 */
export async function handleSupplierJobError(
  job: Job,
  token: string | undefined,
  e: unknown,
  hooks: SupplierJobErrorHooks,
): Promise<never> {
  if (e instanceof SupplierRateLimitError) {
    const at = Date.now() + e.retryAfterMs;
    await hooks.onRetry?.(errorText(e), new Date(at));
    await job.moveToDelayed(at, token);
    throw new DelayedError();
  }
  const msg = errorText(e);
  // Наша валідація (HttpException: немає пропозиції, вимкнене підключення) повтором не виправиться;
  // невідома помилка (обрив з'єднання з БД тощо) — повторюється.
  const retryable = isSupplierError(e) ? e.retryable : !(e instanceof HttpException);
  if (!retryable) {
    await hooks.onFinal(msg);
    throw new UnrecoverableError(msg);
  }
  if (isLastAttempt(job)) {
    await hooks.onFinal(msg);
    throw e instanceof Error ? e : new Error(msg);
  }
  await hooks.onRetry?.(msg, nextRetryAt(job));
  throw e instanceof Error ? e : new Error(msg);
}
