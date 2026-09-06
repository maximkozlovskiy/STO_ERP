import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { NotificationProviderRegistry } from './providers/provider-registry';

interface SendSmsJob {
  orgId: string;
  phone: string;
  message: string;
  provider: string;
  apiKey: string;
  senderName: string;
}

/** §2.4 PII: у логах показуємо лише останні 4 цифри телефону. */
function maskPhone(phone: string): string {
  return phone.length <= 4 ? '****' : `****${phone.slice(-4)}`;
}

// Concurrency=3: кожна SMS — окремий зовнішній HTTP виклик (10s timeout).
// Без concurrency черга з 30 SMS виконувалась би ~300s серійно.
@Injectable()
@Processor('sms', { concurrency: 3 })
export class SmsProcessor extends WorkerHost {
  private readonly logger = new Logger(SmsProcessor.name);

  constructor(private readonly registry: NotificationProviderRegistry) {
    super();
  }

  async process(job: Job<SendSmsJob>): Promise<void> {
    const { phone, message, provider, apiKey, senderName } = job.data;

    const impl = this.registry.get(provider);
    if (!impl) {
      // Невідомий провайдер — не ретраїмо (це конфіг-помилка, не транзієнт).
      this.logger.warn(`SMS пропущено: невідомий провайдер "${provider}"`);
      return;
    }

    const result = await impl.send({
      channel: NotificationChannel.SMS,
      phone,
      message,
      creds: { apiKey, senderName },
    });

    if (!result.accepted) {
      // Кидаємо → BullMQ retry (attempts:10, exp backoff). Провайдер відхилив/мережа впала.
      throw new Error(result.error ?? 'SMS відхилено провайдером');
    }

    this.logger.log(
      `SMS надіслано на ${maskPhone(phone)} через ${provider} (id=${result.providerMessageId ?? '—'})`,
    );
  }
}
