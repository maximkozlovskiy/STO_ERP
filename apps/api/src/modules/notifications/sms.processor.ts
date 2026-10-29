import { Processor, InjectQueue, OnWorkerEvent } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel, NotificationEventType } from '@prisma/client';
import type { AutomationSkipReason } from '@sto/shared';
import type { NotificationLogMeta } from './notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { runWithTenant } from '../../common/tenant/tenant-context';
import { NotificationProviderRegistry } from './providers/provider-registry';
import { DeadLetterWorkerHost } from '../../modules/dead-letter/dead-letter-worker-host';
import { DeadLetterService } from '../../modules/dead-letter/dead-letter.service';

/** Один канал у fallback-ланцюзі (див. NotificationsService.ChannelStep). */
interface ChannelStep {
  channel: NotificationChannel;
  provider: string;
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
  /** Повідомлення правила автоматизації: правило, документ, контрагент, тест (BR-AUT-050). */
  meta?: NotificationLogMeta;
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
export class SmsProcessor extends DeadLetterWorkerHost {
  private readonly logger = new Logger(SmsProcessor.name);

  constructor(
    private readonly registry: NotificationProviderRegistry,
    private readonly prisma: PrismaService,
    @InjectQueue('sms') private readonly smsQueue: Queue,
    deadLetter: DeadLetterService,
  ) {
    super(deadLetter);
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
    return runWithTenant({ orgId: job.data.orgId }, async () => {
      const { orgId, branchId, event, meta, chain, chainIndex } = job.data;
      const step = chain?.[chainIndex];
      if (!step) {
        this.logger.warn(`SMS job без валідного кроку (chainIndex=${chainIndex}) — пропущено`);
        return;
      }

      // BR-AUT-016: повідомлення правила відкладене тихими годинами (чи просто в черзі) — на мить
      // відправки документ видалено / оплату сторновано → не надсилати, ланцюг далі не йде.
      const stale = await this.staleReason(orgId, meta);
      if (stale) {
        await this.log(orgId, branchId, { event, meta }, step, 'SKIPPED', {
          skipReason: stale,
          attempt: job.attemptsMade + 1,
        });
        this.logger.log(
          `${step.channel} на ${maskRecipient(step.recipient)} не надіслано: ${stale} ` +
            `(${meta?.documentType} ${meta?.documentId})`,
        );
        return;
      }

      const impl = this.registry.get(step.provider);
      if (!impl) {
        // Невідомий провайдер — конфіг-помилка, не транзієнт. Логуємо FAILED, пробуємо наступний.
        await this.log(orgId, branchId, { event, meta }, step, 'FAILED', {
          error: `Невідомий провайдер "${step.provider}"`,
          attempt: job.attemptsMade + 1,
        });
        await this.tryNext(job);
        return;
      }

      // T8: apiKey НЕ зберігається у job.data (Redis plaintext) — резолвимо+розшифровуємо у point-of-use.
      const apiKey = await this.resolveApiKey(orgId, branchId, step.channel);
      if (!apiKey) {
        await this.log(orgId, branchId, { event, meta }, step, 'FAILED', {
          error: `Не знайдено активний apiKey для ${step.channel}/${step.provider}`,
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
        creds: { apiKey, senderName: step.senderName },
        externalTemplateId: step.externalTemplateId,
      });

      if (result.accepted) {
        await this.log(orgId, branchId, { event, meta }, step, 'SENT', {
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
      await this.log(orgId, branchId, { event, meta }, step, 'REJECTED', {
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
    });
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
        // Обмежуємо утримання невдалих jobs у Redis (діагностика). T8: apiKey у payload вже НЕМАЄ.
        removeOnFail: 200,
      },
    );
  }

  /**
   * T8: резолвимо apiKey у point-of-use (не тримаємо у Redis job.data). Prisma field-encryption
   * extension автоматично розшифровує apiKey/smsApiKey при читанні. Джерело — те саме, що у
   * NotificationsService.resolveConfig: спершу NotificationChannelConfig (@@unique([branchId,channel])),
   * далі legacy BranchSettings.smsApiKey для SMS.
   *
   * R2 (pre-prod re-review): lookup за унікальним ключем {orgId, branchId, channel} — БЕЗ `provider`/
   * `enabled` у where. Провайдера вже обрано на enqueue (він у step.provider); а `enabled:true` у
   * where давав тиху невідправку, якщо адмін перемкнув провайдера чи тимчасово вимкнув канал у вікні
   * між постановкою job і його обробкою (BullMQ backoff до 60с × 10). Ключ беремо з поточного рядка
   * каналу; deletedAt:null лишаємо (видалений конфіг = справді немає ключа).
   */
  private async resolveApiKey(
    orgId: string,
    branchId: string | undefined,
    channel: NotificationChannel,
  ): Promise<string | null> {
    if (!branchId) return null;
    const cfg = await this.prisma.notificationChannelConfig.findFirst({
      where: { orgId, branchId, channel, deletedAt: null },
      select: { apiKey: true },
    });
    if (cfg?.apiKey) return cfg.apiKey;

    // Legacy SMS-шлях (BranchSettings.smsApiKey) — лише для каналу SMS.
    if (channel === NotificationChannel.SMS) {
      const bs = await this.prisma.branchSettings.findFirst({
        where: { orgId, branchId },
        select: { smsApiKey: true },
      });
      if (bs?.smsApiKey) return bs.smsApiKey;
    }
    return null;
  }

  /**
   * BR-AUT-016: чи доречне ще повідомлення правила про документ. Документ видалено (чи його немає
   * в org) — `DOCUMENT_DELETED`; повідомлення про «створено» оплати клієнта / постачальнику, а
   * оплату вже сторновано — `PAYMENT_REVERSED`. Звичайна зміна статусу не скасовує («Виконано»
   * лишається правдою й після «Оплачено»). Тест (`isTest`) і зашиті події — без перевірки.
   */
  private async staleReason(
    orgId: string,
    meta: NotificationLogMeta | undefined,
  ): Promise<AutomationSkipReason | null> {
    if (!meta?.documentType || !meta.documentId || meta.isTest) return null;
    const where = { id: meta.documentId, orgId };
    const live = { deletedAt: true } as const;
    const created = meta.eventKind === 'CREATED';
    let row: { deletedAt?: Date | null } | null;
    switch (meta.documentType) {
      case 'PAYMENT': {
        // Оплата клієнта append-only: без deletedAt, сторно — reversedAt.
        const p = await this.prisma.payment.findFirst({ where, select: { reversedAt: true } });
        if (!p) return 'DOCUMENT_DELETED';
        return created && p.reversedAt ? 'PAYMENT_REVERSED' : null;
      }
      case 'SUPPLIER_PAYMENT': {
        const p = await this.prisma.supplierPayment.findFirst({
          where,
          select: { deletedAt: true, status: true },
        });
        if (!p || p.deletedAt) return 'DOCUMENT_DELETED';
        return created && p.status === 'REVERSED' ? 'PAYMENT_REVERSED' : null;
      }
      case 'WORK_ORDER':
        row = await this.prisma.workOrder.findFirst({ where, select: live });
        break;
      case 'INVOICE':
        row = await this.prisma.invoice.findFirst({ where, select: live });
        break;
      case 'PURCHASE_ORDER':
        row = await this.prisma.purchaseOrder.findFirst({ where, select: live });
        break;
      case 'STOCK_DOCUMENT':
        row = await this.prisma.stockDocument.findFirst({ where, select: live });
        break;
      case 'SUPPLIER_RETURN':
        row = await this.prisma.supplierReturn.findFirst({ where, select: live });
        break;
      case 'BOOKING':
        row = await this.prisma.bookingRequest.findFirst({ where, select: live });
        break;
      case 'TASK':
        row = await this.prisma.task.findFirst({ where, select: live });
        break;
      default: {
        const _exhaustive: never = meta.documentType;
        return _exhaustive;
      }
    }
    return !row || row.deletedAt ? 'DOCUMENT_DELETED' : null;
  }

  /** Append-only NotificationLog. Помилка логу не має зривати відправку. */
  private async log(
    orgId: string,
    branchId: string | undefined,
    source: { event?: NotificationEventType; meta?: NotificationLogMeta },
    step: ChannelStep,
    status: 'SENT' | 'REJECTED' | 'FAILED' | 'SKIPPED',
    extra: {
      providerMessageId?: string;
      error?: string;
      skipReason?: AutomationSkipReason;
      attempt?: number;
    },
  ): Promise<void> {
    const { event, meta } = source;
    // Без зашитої події й без правила — не наш job (старий формат): лог не пишемо.
    if (!event && !meta) return;
    try {
      await this.prisma.notificationLog.create({
        data: {
          orgId,
          branchId,
          eventType: event ?? null,
          ruleId: meta?.ruleId,
          documentType: meta?.documentType,
          documentId: meta?.documentId,
          counterpartyId: meta?.counterpartyId,
          isTest: meta?.isTest ?? false,
          channel: step.channel,
          provider: step.provider,
          recipient: step.recipient,
          providerMessageId: extra.providerMessageId,
          status,
          error: extra.error,
          skipReason: extra.skipReason,
          attempt: extra.attempt ?? 1,
        },
      });
    } catch (e) {
      this.logger.error(`NotificationLog не записано: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Централізований DLQ: терминальний провал → DeadLetterJob (аудит стеку, backend #2).
  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): Promise<void> {
    return this.deadLetterOnFailed(job, err);
  }
}
