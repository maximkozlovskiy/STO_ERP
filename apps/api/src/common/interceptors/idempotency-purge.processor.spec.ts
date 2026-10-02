import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import { IdempotencyPurgeProcessor } from './idempotency-purge.processor';
import type { DeadLetterService } from '../../modules/dead-letter/dead-letter.service';

describe('IdempotencyPurgeProcessor', () => {
  it('видаляє ЛИШЕ протерміновані (expiresAt < now)', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const prisma = { idempotencyKey: { deleteMany } } as never;
    // DeadLetterService потрібен конструктору (DeadLetterWorkerHost), але у process() не
    // задіяний — лише в @OnWorkerEvent('failed'). Мокаємо єдиний використовуваний метод.
    const deadLetter = { capture: vi.fn() } as unknown as DeadLetterService;
    const processor = new IdempotencyPurgeProcessor(prisma, deadLetter);

    await processor.process({} as Job);

    expect(deleteMany).toHaveBeenCalledTimes(1);
    const where = deleteMany.mock.calls[0][0].where;
    expect(where.expiresAt.lt).toBeInstanceOf(Date);
    // MUTATION-VERIFY: прибрати where.expiresAt → deleteMany без фільтра знесла б УСІ ключі
    // (включно з активними резерваціями в обробці) → цей assert впаде.
  });
});
