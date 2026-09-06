import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel, NotificationEventType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationProviderRegistry } from './providers/provider-registry';

/** Один канал у fallback-ланцюзі (див. NotificationsService.ChannelStep). */
interface ChannelStep {
  channel: NotificationChannel;
  provider: string;
  apiKey: string;
  senderName: string;
  message: string;
  subject?: string;
  /** Отримувач цього каналу: телефон (SMS/Viber/TG) або email (EMAIL). */
  recipient: string;
  externalTemplateId?: string;
}

interface SendSmsJob {
  orgId: string;
  branchId?: string;
  event?: NotificationEventType;
  /** Впорядкований fallback-ланцюг каналів (priority ASC); recipient — у кожному кроці. */
  chain: ChannelStep[];
  /** Позиція у ланцюзі для поточного job. Retry цього job повторює саме chain[chainIndex]. */
  chainIndex: number;
}

/** §2.4 PII: маскуємо отримувача у логах. Телефон → ****1234; email → a***@dom. */
function maskRecipient(recipient: string): string {
  const at = recipient.indexOf('@');
  if (at > 0) {
    const name = recipient.slice(0, at);
    const domain = recipient.slice(at);
    return `${name[0]}***${domain}`;
  }
  return recipient.length <= 4 ? '****' : `****${recipient.slice(-4)}`;
}

// Concurrency=3: кожна відправка — окремий зовнішній HTTP виклик (10s timeout).
// Без concurrency черга з 30 повідомлень виконувалась би ~300s серійно.
@Injectable()
@Processor('sms', { concurrency: 3 })
export class SmsProcessor extends WorkerHost {
  private readonly logger = new Logger(SmsProcessor.name);

  constructor(
    private readonly registry: NotificationProviderRegistry,
    private readonly prisma: PrismaService,
    @InjectQueue('sms') private readonly smsQueue: Queue,
  ) {
    super();
  }

  /**
   * Fallback-ланцюг:
   *  - беремо chain[chainIndex]; провайдер send() приймає → лог SENT, СТОП.
   *  - провайдер відхилив → лог REJECTED; якщо є наступний канал — ставимо НОВИЙ job на
   *    chainIndex+1 (delay 0) і завершуємось успішно (щоб BullMQ не ретраїв цей крок).
   *  - це був останній канал → throw → BullMQ retry (attempts:10) повторить саме
   *    chain[chainIndex] (chainIndex у job.data), не рестартуючи ланцюг з нуля.
   */
  async process(job: Job<SendSmsJob>): Promise<void> {
    const { orgId, branchId, event, chain, chainIndex } = job.data;
    const step = chain?.[chainIndex];
    if (!step) {
      this.logger.warn(`SMS job без валідного кроку (chainIndex=${chainIndex}) — пропущено`);
      return;
    }

    const impl = this.registry.get(step.provider);
    if (!impl) {
      // Невідомий провайдер — конфіг-помилка, не транзієнт. Логуємо FAILED, пробуємо наступний.
      await this.log(orgId, branchId, event, step, 'FAILED', {
        error: `Невідомий провайдер "${step.provider}"`,
        attempt: job.attemptsMade + 1,
      });
      await this.tryNext(job);
      return;
    }

    const result = await impl.send({
      channel: step.channel,
      recipient: step.recipient,
      message: step.message,
      subject: step.subject,
      creds: { apiKey: step.apiKey, senderName: step.senderName },
      externalTemplateId: step.externalTemplateId,
    });

    if (result.accepted) {
      await this.log(orgId, branchId, event, step, 'SENT', {
        providerMessageId: result.providerMessageId,
        attempt: job.attemptsMade + 1,
      });
      this.logger.log(
        `${step.channel} надіслано на ${maskRecipient(step.recipient)} через ${step.provider} ` +
          `(id=${result.providerMessageId ?? '—'})`,
      );
      return;
    }

    // Відхилено провайдером — лог REJECTED і спроба наступного каналу.
    await this.log(orgId, branchId, event, step, 'REJECTED', {
      error: result.error,
      attempt: job.attemptsMade + 1,
    });

    const hasNext = chainIndex + 1 < chain.length;
    if (hasNext) {
      this.logger.warn(
        `${step.channel} відхилено (${result.error ?? '—'}) → fallback на ` +
          `${chain[chainIndex + 1].channel} для ${maskRecipient(step.recipient)}`,
      );
      await this.tryNext(job);
      return;
    }

    // Останній канал відхилено → BullMQ retry (транзієнтна помилка провайдера/мережі).
    throw new Error(result.error ?? `${step.channel} відхилено провайдером`);
  }

  /** Ставить наступний канал ланцюга окремим job (chainIndex+1). */
  private async tryNext(job: Job<SendSmsJob>): Promise<void> {
    const { chainIndex, chain } = job.data;
    if (chainIndex + 1 >= chain.length) return;
    await this.smsQueue.add(
      'send-sms',
      { ...job.data, chainIndex: chainIndex + 1 },
      {
        attempts: 10,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: true,
        // §2.4: job.data.chain містить apiKey → обмежуємо утримання невдалих jobs у Redis.
        removeOnFail: 200,
      },
    );
  }

  /** Append-only NotificationLog. Помилка логу не має зривати відправку. */
  private async log(
    orgId: string,
    branchId: string | undefined,
    event: NotificationEventType | undefined,
    step: ChannelStep,
    status: 'SENT' | 'REJECTED' | 'FAILED',
    extra: { providerMessageId?: string; error?: string; attempt?: number },
  ): Promise<void> {
    if (!event) return; // без eventType (обовʼязкове поле) лог не пишемо
    try {
      await this.prisma.notificationLog.create({
        data: {
          orgId,
          branchId,
          eventType: event,
          channel: step.channel,
          provider: step.provider,
          recipient: step.recipient,
          providerMessageId: extra.providerMessageId,
          status,
          error: extra.error,
          attempt: extra.attempt ?? 1,
        },
      });
    } catch (e) {
      this.logger.error(`NotificationLog не записано: ${e instanceof Error ? e.message : e}`);
    }
  }
}
