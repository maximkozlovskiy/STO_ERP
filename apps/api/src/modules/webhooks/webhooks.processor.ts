import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';
import { createHmac } from 'crypto';
import { Logger } from '@nestjs/common';
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
      responseBody = await res.text().catch(() => '');
      status = res.ok ? 'DELIVERED' : 'FAILED';

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      status = 'FAILED';
      this.logger.warn(
        `Webhook delivery failed for endpoint ${endpointId}: ${String(err)}`,
      );
      // Re-throw so BullMQ will retry
      throw err;
    } finally {
      await this.prisma.webhookDelivery.create({
        data: {
          endpointId,
          event,
          payload: payload as any,
          status,
          attempts: (job.attemptsMade ?? 0) + 1,
          responseCode,
          responseBody,
        },
      });
    }
  }
}
