import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { NotificationEventType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export type NotificationEvent = NotificationEventType;

/** Pre-fetched SMS config shared across a batch of recipients in the same org+event. */
export interface NotificationConfig {
  provider: string;
  apiKey: string;
  senderName: string;
  templateBody: string;
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

    await this.sendWithConfig(orgId, phone, config, payload);
  }

  /**
   * Fetch SMS config (branchSettings + template) once for a batch of recipients
   * that share the same orgId, branchId and event type.
   * Returns null if SMS is not configured or template is missing — batch should abort.
   *
   * Performance: follow-up processor sends to up to 2000 recipients/org.
   * Without this, notifications.send() fetched branchSettings + template per recipient
   * = 2 × 2000 = 4000 identical DB reads per daily tick. Now: 2 reads for the whole batch.
   */
  async resolveConfig(
    orgId: string,
    branchId: string,
    event: NotificationEvent,
  ): Promise<NotificationConfig | null> {
    // sto-optimize: narrow to the fields actually consumed downstream — SMS resolve
    // runs on every notification (booking, follow-up batch up to 2000/day), wire
    // payload shrinks from ~25 settings columns to 5 + 1 template body.
    const [branchSettings, template] = await Promise.all([
      this.prisma.branchSettings.findFirst({
        where: { branchId, orgId },
        select: {
          smsEnabled: true,
          smsApiKey: true,
          smsProvider: true,
          smsSenderName: true,
        },
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
      provider: branchSettings.smsProvider ?? 'turbosms',
      apiKey: branchSettings.smsApiKey,
      senderName: branchSettings.smsSenderName ?? 'STO ERP',
      templateBody: template.body,
    };
  }

  /**
   * Enqueue a single SMS using pre-fetched config (no DB reads).
   * Use after resolveConfig() when sending to many recipients with the same config.
   */
  async sendWithConfig(
    orgId: string,
    phone: string,
    config: NotificationConfig,
    vars: Record<string, unknown>,
  ): Promise<void> {
    const message = this.renderTemplate(config.templateBody, vars);
    await this.smsQueue.add(
      'send-sms',
      {
        orgId,
        phone,
        message,
        provider: config.provider,
        apiKey: config.apiKey,
        senderName: config.senderName,
      },
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
