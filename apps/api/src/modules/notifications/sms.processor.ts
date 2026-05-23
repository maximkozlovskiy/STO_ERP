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

  @Process('send-sms')
  async handleSendSms(job: Job<SendSmsJob>) {
    const { phone, message, provider, apiKey, senderName } = job.data;

    if (provider === 'turbosms') {
      await this.sendViaTurboSms(phone, message, apiKey, senderName);
    } else {
      this.logger.warn(`Невідомий SMS-провайдер: ${provider}`);
    }
  }

  private async sendViaTurboSms(phone: string, message: string, apiKey: string, sender: string) {
    const response = await fetch('https://api.turbosms.ua/message/send.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipients: [phone],
        sms: { sender, text: message },
        token: apiKey,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`TurboSMS error ${response.status}: ${err}`);
    }

    const result = await response.json();
    this.logger.log(`SMS надіслано на ${phone}: ${JSON.stringify(result)}`);
  }
}
