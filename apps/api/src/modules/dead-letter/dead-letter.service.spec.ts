import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeadLetterService, sanitizePayload } from './dead-letter.service';
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

  it('редагує sensitive-ключі у payload перед записом (webhooks secret leak)', async () => {
    const job = makeJob({
      data: {
        orgId: 'org-1',
        endpointId: 'ep-1',
        url: 'https://x.example',
        secret: 'whsec_super_sensitive',
        event: 'work_order.created',
      },
    });
    await service.capture(job, new Error('boom'), 'outbound-webhook');
    const payload = prisma.deadLetterJob.create.mock.calls[0][0].data.payload;
    expect(payload.secret).toBe('[REDACTED]');
    // Несекретні поля лишаються (діагностична цінність DLQ збережена).
    expect(payload.orgId).toBe('org-1');
    expect(payload.url).toBe('https://x.example');
    expect(payload.event).toBe('work_order.created');
  });
});

describe('DeadLetterService.resolve', () => {
  let prisma: { deadLetterJob: { updateMany: ReturnType<typeof vi.fn> } };
  let service: DeadLetterService;

  beforeEach(() => {
    prisma = { deadLetterJob: { updateMany: vi.fn() } };
    service = new DeadLetterService(prisma as unknown as PrismaService);
  });

  it('оновлює лише коли рядок належить org (where несе orgId; count>0)', async () => {
    prisma.deadLetterJob.updateMany.mockResolvedValue({ count: 1 });
    const res = await service.resolve('org-1', 'dl-1');
    const where = prisma.deadLetterJob.updateMany.mock.calls[0][0].where;
    expect(where.id).toBe('dl-1');
    expect(where.orgId).toBe('org-1'); // orgId у самому where (не лише у pre-read)
    expect(res).toEqual({ id: 'dl-1', resolved: true });
  });

  it('кидає 404 коли рядок не належить org (крос-tenant / відсутній → count===0)', async () => {
    prisma.deadLetterJob.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.resolve('org-2', 'dl-1')).rejects.toThrow('DLQ-запис не знайдено');
  });
});

describe('sanitizePayload', () => {
  it('редагує різні варіанти імен ключів (case-insensitive, api_key/apiKey/token/password)', () => {
    const out = sanitizePayload({
      apiKey: 'a',
      api_key: 'b',
      Token: 'c',
      password: 'd',
      privateKey: 'e',
      Authorization: 'f',
      pin_code: 'g',
      keep: 'visible',
    }) as Record<string, unknown>;
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.api_key).toBe('[REDACTED]');
    expect(out.Token).toBe('[REDACTED]');
    expect(out.password).toBe('[REDACTED]');
    expect(out.privateKey).toBe('[REDACTED]');
    expect(out.Authorization).toBe('[REDACTED]');
    expect(out.pin_code).toBe('[REDACTED]');
    expect(out.keep).toBe('visible');
  });

  it('редагує вкладені секрети (масив + вкладений обєкт)', () => {
    const out = sanitizePayload({
      chain: [{ provider: 'turbosms', apiKey: 'x' }],
      nested: { creds: { secret: 'y' } },
    }) as Record<string, unknown>;
    const chain = out.chain as Record<string, unknown>[];
    expect(chain[0].provider).toBe('turbosms');
    expect(chain[0].apiKey).toBe('[REDACTED]');
    const nested = out.nested as { creds: Record<string, unknown> };
    expect(nested.creds.secret).toBe('[REDACTED]');
  });

  it('не мутує вхідний обʼєкт (job.data лишається недоторканим для решти обробки)', () => {
    const input = { secret: 'keep-me' };
    const out = sanitizePayload(input) as Record<string, unknown>;
    expect(out.secret).toBe('[REDACTED]');
    expect(input.secret).toBe('keep-me');
  });

  it('обрізає надто глибокі структури (захист від циклів/DoS)', () => {
    let deep: Record<string, unknown> = { v: 'leaf' };
    for (let i = 0; i < 12; i++) deep = { next: deep };
    const out = sanitizePayload(deep);
    // Не кидає, повертає значення (обрізане на глибині).
    expect(out).toBeDefined();
  });
});
