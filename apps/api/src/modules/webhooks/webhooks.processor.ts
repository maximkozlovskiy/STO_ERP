import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';
import { createHmac } from 'crypto';
import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Processor('outbound-webhook')
export class OutboundWebhookProcessor {
  private readonly logger = new Logger(OutboundWebhookProcessor.name);

  constructor(private prisma: PrismaService) {}

  @Process('deliver')
  async processDeliver(job: Job): Promise<void> {
    const { endpointId, url, secret, event, payload } = job.data as {
      endpointId: string;
      url: string;
      secret: string;
      event: string;
      payload: unknown;
    };

    const body = JSON.stringify({
      event,
      payload,
      timestamp: new Date().toISOString(),
    });

    const signature =
      secret
        ? createHmac('sha256', secret).update(body).digest('hex')
        : '';

    let responseCode: number | null = null;
    let status = 'FAILED';
    let responseBody = '';

    let deliveryError: unknown = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(signature ? { 'X-STO-Signature': `sha256=${signature}` } : {}),
          },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      responseCode = res.status;
      responseBody = (await res.text().catch(() => '')).slice(0, 4000);
      status = res.ok ? 'DELIVERED' : 'FAILED';

      if (!res.ok) {
        deliveryError = new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      status = 'FAILED';
      deliveryError = err;
      this.logger.warn(
        `Webhook delivery failed for endpoint ${endpointId}: ${String(err)}`,
      );
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
