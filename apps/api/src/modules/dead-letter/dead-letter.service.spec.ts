import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeadLetterService } from './dead-letter.service';
import type { PrismaService } from '../../prisma/prisma.service';

// runUnscoped просто виконує callback — стабимо, щоб unit-тест не тягнув ALS.
vi.mock('../../common/tenant/tenant-context', () => ({
  runUnscoped: (fn: () => unknown) => fn(),
}));

function makeJob(over: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    name: 'send-sms',
    data: { orgId: 'org-1', phone: '+380...' },
    attemptsMade: 10,
    opts: { attempts: 10 },
    failedReason: 'boom',
    stacktrace: ['at a', 'at b'],
    ...over,
  } as never;
}

describe('DeadLetterService.capture', () => {
  let prisma: { deadLetterJob: { create: ReturnType<typeof vi.fn> } };
  let service: DeadLetterService;

  beforeEach(() => {
    prisma = { deadLetterJob: { create: vi.fn().mockResolvedValue({ id: 'dl-1' }) } };
    service = new DeadLetterService(prisma as unknown as PrismaService);
  });

  it('маппить job → DeadLetterJob-рядок (orgId з job.data, queueName, attempts, payload)', async () => {
    await service.capture(makeJob(), new Error('boom'), 'sms');
    expect(prisma.deadLetterJob.create).toHaveBeenCalledTimes(1);
    const data = prisma.deadLetterJob.create.mock.calls[0][0].data;
    expect(data.orgId).toBe('org-1');
    expect(data.queueName).toBe('sms');
    expect(data.jobName).toBe('send-sms');
    expect(data.bullJobId).toBe('job-1');
    expect(data.attemptsMade).toBe(10);
    expect(data.maxAttempts).toBe(10);
    expect(data.failedReason).toBe('boom');
    expect(data.stacktrace).toBe('at a\nat b');
    expect(data.payload).toEqual({ orgId: 'org-1', phone: '+380...' });
  });

  it('orgId null коли job.data не має orgId (org-agnostic scheduler-job)', async () => {
    await service.capture(makeJob({ data: {} }), new Error('x'), 'nbu-fetch');
    expect(prisma.deadLetterJob.create.mock.calls[0][0].data.orgId).toBeNull();
  });

  it('failedReason truncate до 1000; stacktrace до 4000', async () => {
    const longMsg = 'a'.repeat(1500);
    await service.capture(makeJob({ stacktrace: ['x'.repeat(5000)] }), new Error(longMsg), 'sms');
    const data = prisma.deadLetterJob.create.mock.calls[0][0].data;
    expect(data.failedReason.length).toBe(1000);
    expect(data.stacktrace.length).toBe(4000);
  });

  it('fail-open: помилка create НЕ кидається назовні (не зриває обробку черги)', async () => {
    prisma.deadLetterJob.create.mockRejectedValue(new Error('DB down'));
    await expect(service.capture(makeJob(), new Error('boom'), 'sms')).resolves.toBeUndefined();
  });

  it('maxAttempts дефолтиться до 1 коли opts.attempts не задано', async () => {
    await service.capture(makeJob({ opts: {} }), new Error('x'), 'sms');
    expect(prisma.deadLetterJob.create.mock.calls[0][0].data.maxAttempts).toBe(1);
  });

  it('null stacktrace коли job.stacktrace порожній', async () => {
    await service.capture(makeJob({ stacktrace: [] }), new Error('x'), 'sms');
    expect(prisma.deadLetterJob.create.mock.calls[0][0].data.stacktrace).toBeNull();
  });
});
