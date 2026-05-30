import { Test } from '@nestjs/testing';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Job } from 'bull';
import { OutboundWebhookProcessor } from './webhooks.processor';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Bug #125 — regression guard for the webhook delivery processor.
 *
 * The processor has TWO critical security features added in cycle-1/cycle-2
 * SSRF defense (Bug #114 / IPv6-redirect followup) that MUST stay in place:
 *
 *   1. `validatePublicUrl` pre-flight check — refuses to even open a socket
 *      to private/loopback/link-local targets.
 *   2. `redirect: 'manual'` + 3xx -> FAILED — refuses to follow redirects
 *      after the URL has been validated (otherwise a malicious endpoint can
 *      bounce the POST to an internal target via `302 Location: http://...`).
 *
 * Without these tests, a future refactor could quietly remove either guard
 * and we would not notice until the next SSRF incident.
 */

interface WebhookJobData {
  endpointId: string;
  url: string;
  secret: string;
  event: string;
  payload: unknown;
}

const makeJob = (data: Partial<WebhookJobData>, attemptsMade = 0): Job =>
  ({
    data: {
      endpointId: 'ep-1',
      url: 'https://hooks.example.com/webhook',
      secret: '',
      event: 'WO_STATUS_CHANGED',
      payload: { id: 'wo-1', status: 'COMPLETED' },
      ...data,
    },
    attemptsMade,
  }) as unknown as Job;

const makePrismaMock = () => ({
  webhookDelivery: { create: vi.fn().mockResolvedValue({}) },
});

describe('OutboundWebhookProcessor.processDeliver', () => {
  let processor: OutboundWebhookProcessor;
  let prisma: ReturnType<typeof makePrismaMock>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    const module = await Test.createTestingModule({
      providers: [OutboundWebhookProcessor, { provide: PrismaService, useValue: prisma }],
    }).compile();
    processor = module.get(OutboundWebhookProcessor);
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('SSRF pre-flight (Bug #114 / IPv6 cycle-2)', () => {
    it('блокує loopback URL: не викликає fetch, пише FAILED delivery, не throw', async () => {
      await processor.processDeliver(makeJob({ url: 'http://127.0.0.1:6379/' }));

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(1);
      const call = prisma.webhookDelivery.create.mock.calls[0][0];
      expect(call.data.status).toBe('FAILED');
      expect(call.data.responseBody).toContain('loopback');
    });

    it('блокує IPv6 ULA (брекети + regex bypass з cycle-2)', async () => {
      await processor.processDeliver(makeJob({ url: 'http://[fc00::1]/hook' }));

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(prisma.webhookDelivery.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'FAILED',
            responseBody: expect.stringContaining('ULA'),
          }),
        }),
      );
    });

    it('блокує IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)', async () => {
      await processor.processDeliver(makeJob({ url: 'http://[::ffff:127.0.0.1]/' }));
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('SSRF block НЕ re-throw (не ретраїти config-bug)', async () => {
      // If this re-threw, BullMQ would retry indefinitely against an internal
      // endpoint that will never be valid. The processor must return cleanly.
      await expect(
        processor.processDeliver(makeJob({ url: 'http://localhost/' })),
      ).resolves.toBeUndefined();
    });
  });

  describe('redirect handling (cycle-2 SSRF defense)', () => {
    it('викликає fetch з redirect: "manual"', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      await processor.processDeliver(makeJob({}));

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0];
      expect(init).toMatchObject({ redirect: 'manual' });
    });

    it('302 → пише FAILED з "Redirect to ... blocked" + throw (BullMQ retry)', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('', {
          status: 302,
          headers: { Location: 'http://internal.local/secret' },
        }),
      );

      await expect(processor.processDeliver(makeJob({}))).rejects.toThrow(/Redirect not allowed/);

      // 302 path writes its OWN delivery record (with the redirect target),
      // then re-throws BEFORE the success-path duplicate write. So we expect
      // exactly ONE webhookDelivery row.
      expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(1);
      const call = prisma.webhookDelivery.create.mock.calls[0][0];
      expect(call.data.status).toBe('FAILED');
      expect(call.data.responseCode).toBe(302);
      expect(call.data.responseBody).toContain('internal.local');
      expect(call.data.responseBody).toContain('blocked');
    });

    it('301 теж блокується', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('', {
          status: 301,
          headers: { Location: 'http://[::1]/admin' },
        }),
      );
      await expect(processor.processDeliver(makeJob({}))).rejects.toThrow();
      expect(prisma.webhookDelivery.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ responseCode: 301, status: 'FAILED' }),
        }),
      );
    });
  });

  describe('successful delivery', () => {
    it('200 → status="DELIVERED", не re-throw', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('processed', { status: 200 }));
      await expect(processor.processDeliver(makeJob({}))).resolves.toBeUndefined();
      expect(prisma.webhookDelivery.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'DELIVERED',
            responseCode: 200,
            attempts: 1,
          }),
        }),
      );
    });

    it('додає X-STO-Signature header при наявності secret (HMAC-SHA256)', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      await processor.processDeliver(makeJob({ secret: 'super-secret-key' }));

      const [, init] = fetchSpy.mock.calls[0];
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['X-STO-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
    });

    it('НЕ додає X-STO-Signature при порожньому secret', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      await processor.processDeliver(makeJob({ secret: '' }));

      const [, init] = fetchSpy.mock.calls[0];
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers['X-STO-Signature']).toBeUndefined();
    });
  });

  describe('failed delivery (5xx, network errors)', () => {
    it('500 → status="FAILED" + re-throw для BullMQ retry', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('server error', { status: 500 }));
      await expect(processor.processDeliver(makeJob({}))).rejects.toThrow(/HTTP 500/);
      expect(prisma.webhookDelivery.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'FAILED', responseCode: 500 }),
        }),
      );
    });

    it('network error (timeout) → FAILED + re-throw', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('AbortError: aborted'));
      await expect(processor.processDeliver(makeJob({}))).rejects.toThrow(/aborted/);
      expect(prisma.webhookDelivery.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'FAILED', responseCode: null }),
        }),
      );
    });

    it('DB write fail НЕ ламає re-throw мережевої помилки', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('boom', { status: 500 }));
      prisma.webhookDelivery.create.mockRejectedValueOnce(new Error('DB down'));

      // Original HTTP 500 error must still surface for BullMQ retry — the DB
      // logging failure is swallowed by its own try/catch.
      await expect(processor.processDeliver(makeJob({}))).rejects.toThrow(/HTTP 500/);
    });
  });

  describe('attempt counter', () => {
    it('attempts = job.attemptsMade + 1', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      await processor.processDeliver(makeJob({}, 4));
      expect(prisma.webhookDelivery.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ attempts: 5 }) }),
      );
    });
  });
});
