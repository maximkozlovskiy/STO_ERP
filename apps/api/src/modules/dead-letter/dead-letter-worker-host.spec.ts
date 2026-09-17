import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeadLetterWorkerHost } from './dead-letter-worker-host';
import type { DeadLetterService } from './dead-letter.service';

// Конкретний тест-підклас (база абстрактна): process no-op, worker.name застабано.
class TestProcessor extends DeadLetterWorkerHost {
  constructor(dl: DeadLetterService) {
    super(dl);
    // `worker` — readonly getter у WorkerHost; у рантаймі його ставить @nestjs/bullmq.
    // У тесті визначаємо власне значення через defineProperty (getter не має сеттера).
    Object.defineProperty(this, 'worker', { value: { name: 'test-queue' }, configurable: true });
  }
  async process(): Promise<void> {}
  // імітуємо decorated-handler підкласу.
  onFailed(job: never, err: Error): Promise<void> {
    return this.deadLetterOnFailed(job, err);
  }
}

function job(attemptsMade: number, attempts?: number) {
  return { attemptsMade, opts: { attempts }, id: 'j', name: 'n', data: {} } as never;
}

describe('DeadLetterWorkerHost.deadLetterOnFailed — терминальний гейт', () => {
  let capture: ReturnType<typeof vi.fn>;
  let proc: TestProcessor;

  beforeEach(() => {
    capture = vi.fn().mockResolvedValue(undefined);
    proc = new TestProcessor({ capture } as unknown as DeadLetterService);
  });

  it('НЕ пише у DLQ на проміжному провалі (attemptsMade < attempts)', async () => {
    await proc.onFailed(job(9, 10), new Error('boom'));
    expect(capture).not.toHaveBeenCalled();
  });

  it('пише у DLQ на ТЕРМИНАЛЬНОМУ провалі (attemptsMade >= attempts)', async () => {
    await proc.onFailed(job(10, 10), new Error('boom'));
    expect(capture).toHaveBeenCalledTimes(1);
    // передає ім'я черги з worker.name.
    expect(capture.mock.calls[0][2]).toBe('test-queue');
  });

  it('attempts не задано → maxAttempts=1 → перший провал терминальний', async () => {
    await proc.onFailed(job(1, undefined), new Error('boom'));
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
