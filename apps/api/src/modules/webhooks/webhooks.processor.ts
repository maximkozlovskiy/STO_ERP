import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { createHmac } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { validatePublicUrl } from '../../common/utils/url-guard';

// Concurrency=5: кожна доставка — окремий зовнішній HTTP виклик (10s timeout).
// За замовчуванням bull обробляє 1 job за раз на processor → черга з 20 webhook
// виконувалась би 200+ секунд серійно. З concurrency=5 — до 5 паралельних HTTP
// calls, burst-latency знижується в 5× (20 jobs → ~40s замість ~200s).
@Injectable()
@Processor('outbound-webhook', { concurrency: 5 })
export class OutboundWebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboundWebhookProcessor.name);

  constructor(private prisma: PrismaService) {
    super();
  }

  async process(job: Job): Promise<void> {
    const { endpointId, url, secret, event, payload } = job.data as {
      endpointId: string;
      url: string;
      secret: string;
      event: string;
      payload: unknown;
    };

    // Bug #114: defense-in-depth SSRF check at delivery time. The URL was validated
    // at create/update, but DNS rebinding or a stale endpoint config could still
    // route to an internal target. We refuse to even open the connection.
    const urlError = validatePublicUrl(url);
    if (urlError) {
      this.logger.warn(`Webhook ${endpointId}: blocked SSRF candidate — ${urlError}`);
      // Log failed delivery, then mark job as permanently failed (no retry — config bug).
      try {
        await this.prisma.webhookDelivery.create({
          data: {
            endpointId,
            event,
            payload: payload as Prisma.InputJsonValue,
            status: 'FAILED',
            attempts: (job.attemptsMade ?? 0) + 1,
            responseCode: null,
            responseBody: `Blocked: ${urlError}`,
          },
        });
      } catch (logErr) {
        this.logger.error(`Failed to record blocked delivery for ${endpointId}: ${String(logErr)}`);
      }
      // Do NOT re-throw — retrying makes no sense for a config-level block.
      return;
    }

    const body = JSON.stringify({
      event,
      payload,
      timestamp: new Date().toISOString(),
    });

    const signature = secret ? createHmac('sha256', secret).update(body).digest('hex') : '';

    let responseCode: number | null = null;
    let status = 'FAILED';
    let responseBody = '';

    let deliveryError: unknown = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      let res: Response;
      try {
        // SSRF defense-in-depth (cycle-2): refuse to follow redirects so a
        // malicious endpoint cannot 302 the request to an internal target
        // (e.g. http://localhost:6379, http://169.254.169.254) after we've
        // already passed validatePublicUrl on the original URL.
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(signature ? { 'X-STO-Signature': `sha256=${signature}` } : {}),
          },
          body,
          signal: controller.signal,
          redirect: 'manual',
        });
      } finally {
        clearTimeout(timer);
      }

      // Treat any redirect (3xx with Location) as failure — Webhook receivers
      // must publish a stable URL, not bounce through redirectors. Set the
      // outcome variables and let the SINGLE delivery-log block below record
      // them (avoiding the earlier double-write where this branch wrote its
      // own row AND then the outer log wrote a second row via the catch path).
      if (res.status >= 300 && res.status < 400) {
        deliveryError = new Error(`Redirect not allowed (HTTP ${res.status})`);
        status = 'FAILED';
        responseCode = res.status;
        responseBody = `Redirect to ${res.headers.get('location') ?? '?'} blocked`;
      } else {
        responseCode = res.status;
        responseBody = (await res.text().catch(() => '')).slice(0, 4000);
        status = res.ok ? 'DELIVERED' : 'FAILED';

        if (!res.ok) {
          deliveryError = new Error(`HTTP ${res.status}`);
        }
      }
    } catch (err) {
      status = 'FAILED';
      deliveryError = err;
      this.logger.warn(`Webhook delivery failed for endpoint ${endpointId}: ${String(err)}`);
    }

    // Log every attempt — wrap in its own try/catch so a DB hiccup doesn't mask the
    // delivery error or break BullMQ retry semantics.
    try {
      await this.prisma.webhookDelivery.create({
        data: {
          endpointId,
          event,
          payload: payload as Prisma.InputJsonValue,
          status,
          attempts: (job.attemptsMade ?? 0) + 1,
          responseCode,
          responseBody,
        },
      });
    } catch (logErr) {
      this.logger.error(
        `Failed to record webhook delivery for endpoint ${endpointId}: ${String(logErr)}`,
      );
    }

    // Re-throw original error so BullMQ retries with exponential backoff.
    if (deliveryError) throw deliveryError;
  }
}
