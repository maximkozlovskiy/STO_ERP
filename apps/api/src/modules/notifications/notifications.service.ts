import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NotificationChannel, NotificationEventType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export type NotificationEvent = NotificationEventType;

/** Один канал у fallback-ланцюзі: провайдер + креди + вже відрендерений текст. */
export interface ChannelStep {
  channel: NotificationChannel;
  provider: string;
  apiKey: string;
  senderName: string;
  message: string;
}

/**
 * Впорядкований fallback-ланцюг каналів (за пріоритетом) для однієї події+філії.
 * Спільний для батчу отримувачів (текст рендериться per-recipient у sendWithConfig).
 */
export interface NotificationConfig {
  /** Впорядковані enabled-канали (priority ASC). templateBody — шаблон ДО рендеру. */
  channels: {
    channel: NotificationChannel;
    provider: string;
    apiKey: string;
    senderName: string;
    templateBody: string;
  }[];
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('sms') private readonly smsQueue: Queue,
  ) {}

  async send(
    orgId: string,
    event: NotificationEvent,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const branchId = typeof payload.branchId === 'string' ? payload.branchId : undefined;
    if (!branchId) {
      this.logger.debug(`branchId не вказано для org=${orgId}, event=${event} — SMS пропущено`);
      return;
    }
    const phone = typeof payload.phone === 'string' ? payload.phone : undefined;
    if (!phone) return;

    const config = await this.resolveConfig(orgId, branchId, event);
    if (!config) return;

    await this.sendWithConfig(orgId, phone, config, payload, branchId, event);
  }

  /**
   * Побудова fallback-ланцюга каналів для батчу отримувачів (спільний orgId+branchId+event).
   * Повертає null якщо жоден канал не налаштований/немає шаблону — батч аборт.
   *
   * Джерело каналів (з fallback на legacy):
   *  1) NotificationChannelConfig — впорядковані enabled-канали (priority ASC). Кожному
   *     каналу підбирається активний NotificationTemplate цього channel; без шаблону канал
   *     тихо пропускається (fallback перескочить на наступний).
   *  2) Legacy: якщо конфіг-рядків немає — читаємо BranchSettings.sms* як одноканальний
   *     SMS-ланцюг (зворотна сумісність до data-migration).
   *
   * Perf: follow-up-процесор шле до 2000 отримувачів/org → читаємо конфіг+шаблони ОДИН раз
   * на батч, не per-recipient.
   */
  async resolveConfig(
    orgId: string,
    branchId: string,
    event: NotificationEvent,
  ): Promise<NotificationConfig | null> {
    const channelConfigs = await this.prisma.notificationChannelConfig.findMany({
      where: { orgId, branchId, enabled: true, deletedAt: null, apiKey: { not: null } },
      orderBy: { priority: 'asc' },
      select: { channel: true, provider: true, apiKey: true, senderName: true },
    });

    if (channelConfigs.length > 0) {
      // Шаблони для всіх задіяних каналів — одним запитом.
      const wantedChannels = [...new Set(channelConfigs.map(c => c.channel))];
      const templates = await this.prisma.notificationTemplate.findMany({
        where: { orgId, eventType: event, channel: { in: wantedChannels }, isActive: true },
        select: { channel: true, body: true },
      });
      const byChannel = new Map(templates.map(t => [t.channel, t.body]));

      const channels = channelConfigs
        .filter(c => byChannel.has(c.channel))
        .map(c => ({
          channel: c.channel,
          provider: c.provider,
          apiKey: c.apiKey as string, // гарантовано not-null через where
          senderName: c.senderName ?? 'STO ERP',
          templateBody: byChannel.get(c.channel) as string,
        }));

      if (channels.length === 0) {
        this.logger.debug(`Жодного каналу з шаблоном для org=${orgId}, event=${event}`);
        return null;
      }
      return { channels };
    }

    // Legacy fallback — одноканальний SMS із BranchSettings.
    const [branchSettings, template] = await Promise.all([
      this.prisma.branchSettings.findFirst({
        where: { branchId, orgId },
        select: { smsEnabled: true, smsApiKey: true, smsProvider: true, smsSenderName: true },
      }),
      this.prisma.notificationTemplate.findFirst({
        where: { orgId, eventType: event, channel: 'SMS', isActive: true },
        select: { body: true },
      }),
    ]);

    if (!branchSettings?.smsEnabled || !branchSettings?.smsApiKey) {
      this.logger.debug(`SMS не налаштовано для org=${orgId}, event=${event}`);
      return null;
    }
    if (!template) {
      this.logger.debug(`Шаблон сповіщення ${event}/SMS не знайдено для org=${orgId}`);
      return null;
    }

    return {
      channels: [
        {
          channel: NotificationChannel.SMS,
          provider: branchSettings.smsProvider ?? 'turbosms',
          apiKey: branchSettings.smsApiKey,
          senderName: branchSettings.smsSenderName ?? 'STO ERP',
          templateBody: template.body,
        },
      ],
    };
  }

  /**
   * Ставить у чергу fallback-ланцюг для одного отримувача (без DB-читань).
   * Текст рендериться per-channel (Viber-шаблон може відрізнятись від SMS).
   * Processor іде ланцюгом: chain[chainIndex] accepted → STOP; reject → наступний канал.
   */
  async sendWithConfig(
    orgId: string,
    phone: string,
    config: NotificationConfig,
    vars: Record<string, unknown>,
    branchId?: string,
    event?: NotificationEvent,
  ): Promise<void> {
    const chain: ChannelStep[] = config.channels.map(c => ({
      channel: c.channel,
      provider: c.provider,
      apiKey: c.apiKey,
      senderName: c.senderName,
      message: this.renderTemplate(c.templateBody, vars),
    }));
    if (chain.length === 0) return;

    await this.smsQueue.add(
      'send-sms',
      { orgId, branchId, event, phone, chain, chainIndex: 0 },
      {
        attempts: 10,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: true,
      },
    );
  }

  async findTemplates(orgId: string) {
    const rows = await this.prisma.notificationTemplate.findMany({
      where: { orgId },
      orderBy: [{ eventType: 'asc' }, { channel: 'asc' }],
      take: 100,
    });
    return rows.map(r => ({ ...r, syncVersion: Number(r.syncVersion) }));
  }

  async updateTemplate(
    orgId: string,
    id: string,
    dto: { body: string; subject?: string; isActive: boolean },
  ) {
    // sto-optimize: narrow existence guard — full row not needed, update returns it.
    const template = await this.prisma.notificationTemplate.findFirst({
      where: { id, orgId },
      select: { id: true },
    });
    if (!template) throw new NotFoundException('Шаблон не знайдено');
    const updated = await this.prisma.notificationTemplate.update({
      where: { id, orgId },
      data: { body: dto.body, subject: dto.subject, isActive: dto.isActive },
    });
    return { ...updated, syncVersion: Number(updated.syncVersion) };
  }

  private renderTemplate(template: string, vars: Record<string, unknown>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ''));
  }
}
