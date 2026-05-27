import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { NotificationEventType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export type NotificationEvent = NotificationEventType;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('sms') private readonly smsQueue: Queue,
  ) {}

  async send(orgId: string, event: NotificationEvent, payload: Record<string, unknown>): Promise<void> {
    // Load branch settings for SMS config — branchId is required; skip without it
    const branchId = typeof payload.branchId === 'string' ? payload.branchId : undefined;
    if (!branchId) {
      this.logger.debug(`branchId не вказано для org=${orgId}, event=${event} — SMS пропущено`);
      return;
    }
    const branchSettings = await this.prisma.branchSettings.findFirst({ where: { branchId, orgId } });

    if (!branchSettings?.smsEnabled || !branchSettings?.smsApiKey) {
      this.logger.debug(`SMS не налаштовано для org=${orgId}, event=${event}`);
      return;
    }

    // Load notification template
    const template = await this.prisma.notificationTemplate.findFirst({
      where: { orgId, eventType: event, channel: 'SMS', isActive: true },
    });

    if (!template) {
      this.logger.debug(`Шаблон сповіщення ${event}/SMS не знайдено для org=${orgId}`);
      return;
    }

    const phone = typeof payload.phone === 'string' ? payload.phone : undefined;
    if (!phone) return;

    const message = this.renderTemplate(template.body, payload);

    // Enqueue SMS (offline-first — retry if no internet)
    await this.smsQueue.add('send-sms', {
      orgId,
      phone,
      message,
      provider: branchSettings.smsProvider ?? 'turbosms',
      apiKey: branchSettings.smsApiKey,
      senderName: branchSettings.smsSenderName ?? 'STO ERP',
    }, {
      attempts: 10,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: true,
    });
  }

  async findTemplates(orgId: string) {
    const rows = await this.prisma.notificationTemplate.findMany({
      where: { orgId },
      orderBy: [{ eventType: 'asc' }, { channel: 'asc' }],
      take: 100,
    });
    return rows.map(r => ({ ...r, syncVersion: Number(r.syncVersion) }));
  }

  async updateTemplate(orgId: string, id: string, dto: { body: string; subject?: string; isActive: boolean }) {
    const template = await this.prisma.notificationTemplate.findFirst({
      where: { id, orgId },
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
