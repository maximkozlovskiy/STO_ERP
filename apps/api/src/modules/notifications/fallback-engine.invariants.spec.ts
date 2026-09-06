import * as fc from 'fast-check';
import { vi, describe, it, expect } from 'vitest';
import { NotificationChannel } from '@prisma/client';
import { Job, Queue } from 'bullmq';
import { SmsProcessor } from './sms.processor';
import { NotificationProviderRegistry } from './providers/provider-registry';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Property-based інваріанти fallback-движка.
 *
 * Для будь-якого ланцюга з N каналів і будь-якої послідовності outcomes
 * (accept / reject / unknown-provider) при повному прогоні ланцюга (через новий job на
 * кожен fallback) мають виконуватись:
 *   I1. Максимум ОДИН SENT-лог за весь ланцюг (перший accept зупиняє).
 *   I2. Кожен канал відвідується рівно один раз (без пропусків/повторів) поки не accept.
 *   I3. Якщо жоден канал не accepted і останній — reject провайдером → останній job throw
 *       (BullMQ retry), інакше (accept АБО останній unknown-provider) — без throw.
 *   I4. Кількість SENT + (REJECTED|FAILED) логів = кількість відвіданих каналів.
 */
type Outcome = 'accept' | 'reject' | 'unknown';

/** Прогін усього ланцюга послідовно: емулює BullMQ (новий job на кожен tryNext). */
async function runChain(outcomes: Outcome[]): Promise<{
  sent: number;
  rejectedOrFailed: number;
  visited: number;
  threw: boolean;
}> {
  const logCalls: string[] = [];
  const logCreate = vi.fn().mockImplementation((arg: { data: { status: string } }) => {
    logCalls.push(arg.data.status);
    return Promise.resolve({});
  });
  const prisma = { notificationLog: { create: logCreate } } as unknown as PrismaService;

  // queue.add імітує BullMQ: збирає майбутні job.data для послідовного прогону.
  const pending: Array<{ chainIndex: number }> = [];
  const queueAdd = vi.fn().mockImplementation((_name, data: { chainIndex: number }) => {
    pending.push({ chainIndex: data.chainIndex });
    return Promise.resolve({});
  });
  const queue = { add: queueAdd } as unknown as Queue;

  const send = vi.fn();
  const registry = {
    get: vi.fn((_provider: string) => ({ send })),
  } as unknown as NotificationProviderRegistry;

  const processor = new SmsProcessor(registry, prisma, queue);
  // Приглушити app-логи у 600 property-run-ах (шум, не поведінка).
  vi.spyOn(processor['logger'], 'log').mockImplementation(() => undefined);
  vi.spyOn(processor['logger'], 'warn').mockImplementation(() => undefined);
  vi.spyOn(processor['logger'], 'error').mockImplementation(() => undefined);

  const chain = outcomes.map((_, i) => ({
    channel: i % 2 === 0 ? NotificationChannel.VIBER : NotificationChannel.SMS,
    provider: 'turbosms',
    apiKey: 'k',
    senderName: 'STO',
    message: `m-${i}`,
    recipient: '380671112233',
  }));

  let visited = 0;
  let threw = false;
  let idx = 0;
  let stop = false;

  while (idx < outcomes.length && !stop) {
    const outcome = outcomes[idx];
    // Налаштувати registry.get і send для поточного каналу.
    (registry.get as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      outcome === 'unknown' ? null : { send },
    );
    if (outcome === 'accept')
      send.mockResolvedValueOnce({ accepted: true, providerMessageId: 'x' });
    else if (outcome === 'reject') send.mockResolvedValueOnce({ accepted: false, error: 'rej' });

    const job = {
      data: {
        orgId: 'o',
        branchId: 'b',
        event: 'WO_COMPLETED',
        chain,
        chainIndex: idx,
      },
      attemptsMade: 0,
    } as unknown as Job;

    visited++;
    try {
      await processor.process(job);
    } catch {
      threw = true;
    }

    if (outcome === 'accept') {
      stop = true; // accept зупиняє ланцюг
    } else if (pending.length > 0) {
      idx = pending.shift()!.chainIndex; // перейти на fallback-job
    } else {
      stop = true; // останній канал — далі нема
    }
  }

  const sent = logCalls.filter(s => s === 'SENT').length;
  const rejectedOrFailed = logCalls.filter(s => s === 'REJECTED' || s === 'FAILED').length;
  return { sent, rejectedOrFailed, visited, threw };
}

describe('fallback-engine invariants (property-based)', () => {
  it('I1+I4: максимум 1 SENT; SENT + REJECTED/FAILED = кількість відвіданих каналів', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Outcome>('accept', 'reject', 'unknown'), {
          minLength: 1,
          maxLength: 6,
        }),
        async outcomes => {
          const { sent, rejectedOrFailed, visited } = await runChain(outcomes);
          expect(sent).toBeLessThanOrEqual(1);
          expect(sent + rejectedOrFailed).toBe(visited);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('I2: ланцюг зупиняється на першому accept — жоден канал після нього не відвідується', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Outcome>('reject', 'unknown'), { minLength: 0, maxLength: 4 }),
        fc.array(fc.constantFrom<Outcome>('accept', 'reject', 'unknown'), {
          minLength: 0,
          maxLength: 3,
        }),
        async (before, after) => {
          const outcomes: Outcome[] = [...before, 'accept', ...after];
          const { sent, visited } = await runChain(outcomes);
          expect(sent).toBe(1);
          // Відвідано рівно префікс до accept включно (before.length + 1), не далі.
          expect(visited).toBe(before.length + 1);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('I3: жодного accept + останній канал reject провайдером → throw (retry); інакше без throw', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<Outcome>('reject', 'unknown'), { minLength: 1, maxLength: 6 }),
        async outcomes => {
          const { sent, threw } = await runChain(outcomes);
          expect(sent).toBe(0);
          // throw лише коли останній відвіданий канал — reject провайдером (транзієнт).
          expect(threw).toBe(outcomes[outcomes.length - 1] === 'reject');
        },
      ),
      { numRuns: 200 },
    );
  });
});
