import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Queue, Worker, type Job } from 'bullmq';
import { PaymentPollingProcessor } from './payment-polling.processor';

/**
 * ІНТЕГРАЦІЙНИЙ спек ланцюга опитування онлайн-оплати на СПРАВЖНІЙ черзі BullMQ (живий Redis).
 *
 * Навіщо: опитування — це self-re-enqueue (задача сама ставить наступну). Unit-спек мокає чергу й
 * бачить лише «add викликано». А BullMQ мовчки відкидає `add` з jobId задачі, яка ще існує —
 * активна задача існує до кінця `process`. Поки наступний крок ставився під тим самим jobId, що й
 * поточний, ланцюг обривався після ПЕРШОГО опитування: клієнт платив за QR, а намір лишався
 * PENDING назавжди (Bug #804). Мок цього не показує — показує лише справжня черга.
 *
 * Черга власна (`payment-polling-it-<час>`), після прогону знищується. Затримки між кроками не
 * чекаємо: відкладену задачу одразу просуваємо (`promote`).
 *
 * Умови запуску: Redis на REDIS_URL (типово redis://localhost:6379). Без Redis — SKIP;
 * з REQUIRE_REDIS=1 (CI) недоступний Redis валить спек, а не ховає його.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const QUEUE = `payment-polling-it-${Date.now()}`;
const ORG = '00000000-0000-4000-8000-0000000000a1';
const INTENT = 'intent-it-1';

function connection() {
  const u = new URL(REDIS_URL);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    maxRetriesPerRequest: null,
    // Без Redis не чекаємо вічно: одна спроба з'єднання — і спек іде у SKIP.
    retryStrategy: () => null,
    connectTimeout: 2_000,
  };
}

let redisAvailable = false;
let queue: Queue | undefined;
let worker: Worker | undefined;

beforeAll(async () => {
  const probe = new Queue(QUEUE, { connection: connection() });
  // Без слухача `error` невдале з'єднання стає необробленим винятком процесу.
  probe.on('error', () => undefined);
  try {
    await Promise.race([
      probe.waitUntilReady(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3_000)),
    ]);
    redisAvailable = true;
    queue = probe;
  } catch (err) {
    await probe.close().catch(() => undefined);
    if (process.env.REQUIRE_REDIS === '1') {
      throw new Error(
        `REQUIRE_REDIS=1, але Redis недоступний (${err instanceof Error ? err.message : String(err)}). ` +
          'У CI integration-тест черги не має тихо пропускатись — підніміть Redis.',
      );
    }
  }
}, 15_000);

afterAll(async () => {
  await worker?.close().catch(() => undefined);
  await queue?.obliterate({ force: true }).catch(() => undefined);
  await queue?.close().catch(() => undefined);
});

describe('PaymentPollingProcessor — ланцюг опитування на живій черзі (Bug #804)', () => {
  // guards: BR-PAY-007
  it('після збою шлюзу й після «pending» наступне опитування СПРАВДІ виконується', async () => {
    if (!redisAvailable || !queue) return; // SKIP без Redis

    // Шлюз: двічі недоступний, двічі «ще не оплачено», далі «оплачено».
    const script: Array<() => Promise<{ status: string; raw: string }>> = [
      () => Promise.reject(new Error('fetch failed')),
      () => Promise.reject(new Error('monobank 502: Bad Gateway')),
      () => Promise.resolve({ status: 'pending', raw: 'created' }),
      () => Promise.resolve({ status: 'pending', raw: 'processing' }),
    ];
    const getStatus = vi.fn(() =>
      (script.shift() ?? (() => Promise.resolve({ status: 'paid', raw: 'success' })))(),
    );
    let intentStatus = 'PENDING';
    let paymentId: string | null = null;
    const prisma = {
      onlinePaymentIntent: {
        findFirst: vi.fn(() =>
          Promise.resolve({
            status: intentStatus,
            gateway: 'monobank',
            gatewayInvoiceId: 'gw-it-1',
            expiresAt: new Date(Date.now() + 600_000),
            counterpartyId: 'cp-it',
            invoiceId: 'inv-it',
            amount: 500,
            workOrderId: null,
            paymentId,
          }),
        ),
        updateMany: vi.fn((args: { data: { status: string } }) => {
          if (intentStatus !== 'PENDING') return Promise.resolve({ count: 0 });
          intentStatus = args.data.status;
          return Promise.resolve({ count: 1 });
        }),
        update: vi.fn((args: { data: { paymentId?: string } }) => {
          if (args.data.paymentId) paymentId = args.data.paymentId;
          return Promise.resolve(undefined);
        }),
      },
      payment: { findFirst: vi.fn(() => Promise.resolve(null)) },
      workOrder: { findFirst: vi.fn() },
    };
    const payments = { create: vi.fn(() => Promise.resolve({ id: 'pay-it-1' })) };
    const processor = new PaymentPollingProcessor(
      prisma as never,
      { get: () => ({ getStatus }) } as never,
      {
        resolveByCode: () =>
          Promise.resolve({
            provider: 'monobank',
            apiUrl: null,
            credentials: { token: 'T' },
            shiftMode: 'MANUAL',
          }),
      } as never,
      payments as never,
      queue as never,
      { wrap: (_meta: unknown, fn: () => Promise<unknown>) => fn() } as never,
      { capture: vi.fn() } as never,
    );

    const processed: Array<{ id?: string; data: Record<string, unknown> }> = [];
    worker = new Worker(
      QUEUE,
      async (job: Job) => {
        processed.push({ id: job.id, data: { ...(job.data as Record<string, unknown>) } });
        await processor.process(job as never);
      },
      { connection: connection(), concurrency: 3 },
    );
    worker.on('error', () => undefined);

    // Перша задача — як її ставить OnlinePaymentService.createIntent.
    await queue.add(
      'poll',
      { intentId: INTENT, orgId: ORG },
      { jobId: `payment-poll-${INTENT}`, removeOnComplete: true, removeOnFail: 200 },
    );

    // Затримки 5 с між опитуваннями не чекаємо — просуваємо відкладену задачу одразу.
    const deadline = Date.now() + 20_000;
    while (paymentId === null && Date.now() < deadline) {
      for (const delayed of await queue.getDelayed()) {
        await delayed.promote().catch(() => undefined);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // П'ять звернень до шлюзу: 2 збої + 2 «pending» + «paid». Зі спільним jobId було б одне.
    expect(getStatus).toHaveBeenCalledTimes(5);
    expect(processed.map(p => p.id)).toEqual([
      `payment-poll-${INTENT}`,
      `payment-poll-${INTENT}-p1`,
      `payment-poll-${INTENT}-p2`,
      `payment-poll-${INTENT}-p3`,
      `payment-poll-${INTENT}-p4`,
    ]);
    // Лічильник кроків і позначка «попередній запит упав» доїжджають у дані наступної задачі.
    expect(processed.map(p => p.data.pollAttempts ?? 0)).toEqual([0, 1, 2, 3, 4]);
    expect(processed.map(p => p.data.lastPollFailed ?? false)).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
    // Оплата дійшла: намір PAID, платіж створено рівно один раз.
    expect(intentStatus).toBe('PAID');
    expect(payments.create).toHaveBeenCalledTimes(1);
    expect(paymentId).toBe('pay-it-1');
  }, 30_000);
});
