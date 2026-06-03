import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { Logger } from '@nestjs/common';

interface SendSmsJob {
  orgId: string;
  phone: string;
  message: string;
  provider: string;
  apiKey: string;
  senderName: string;
}

@Processor('sms')
export class SmsProcessor {
  private readonly logger = new Logger(SmsProcessor.name);

  // Concurrency=3: кожна SMS — окремий зовнішній HTTP виклик (10s timeout).
  // Без concurrency черга з 30 SMS виконувалась би ~300s серійно.
  // 3 паралельних виклики до TurboSMS — безпечно (провайдер не має rate-limit per key).
  @Process({ name: 'send-sms', concurrency: 3 })
  async handleSendSms(job: Job<SendSmsJob>) {
    const { phone, message, provider, apiKey, senderName } = job.data;

    if (provider === 'turbosms') {
      await this.sendViaTurboSms(phone, message, apiKey, senderName);
    } else {
      this.logger.warn(`Невідомий SMS-провайдер: ${provider}`);
    }
  }

  private async sendViaTurboSms(phone: string, message: string, apiKey: string, sender: string) {
    // Offline-first invariant: external HTTP must NEVER hang the worker.
    // Without a timeout a flaky TurboSMS endpoint (or no internet) blocks
    // the SMS queue indefinitely — defeats the BullMQ retry-with-backoff design.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await fetch('https://api.turbosms.ua/message/send.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipients: [phone],
          sms: { sender, text: message },
          token: apiKey,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`TurboSMS error ${response.status}: ${err}`);
    }

    const result: unknown = await response.json();
    this.logger.log(`SMS надіслано на ${phone}: ${JSON.stringify(result)}`);
  }
}
