import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PrismaService } from '../../prisma/prisma.service';

export type NotificationEvent =
  | 'WO_COMPLETED'
  | 'WO_ESTIMATE_READY'
  | 'WO_APPROVED'
  | 'WO_IN_PROGRESS'
  | 'WO_READY_FOR_PICKUP'
  | 'PAYMENT_RECEIVED'
  | 'INVOICE_SENT'
  | 'LOW_STOCK_ALERT';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('sms') private readonly smsQueue: Queue,
  ) {}

  async send(orgId: string, event: NotificationEvent, payload: Record<string, any>): Promise<void> {
    // Load branch settings for SMS config
    const branchId = payload.branchId;
    const branchSettings = branchId
      ? await this.prisma.branchSettings.findFirst({ where: { branchId, orgId } })
      : await this.prisma.branchSettings.findFirst({ where: { orgId } });

    if (!branchSettings?.smsEnabled || !branchSettings?.smsApiKey) {
      this.logger.debug(`SMS не налаштовано для org=${orgId}, event=${event}`);
      return;
    }

    // Load notification template
    const template = await this.prisma.notificationTemplate.findFirst({
      where: { orgId, eventType: event as any, channel: 'SMS', isActive: true },
    });

    if (!template) {
      this.logger.debug(`Шаблон сповіщення ${event}/SMS не знайдено для org=${orgId}`);
      return;
    }

    const phone = payload.phone;
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
    return this.prisma.notificationTemplate.findMany({
      where: { orgId },
      orderBy: [{ eventType: 'asc' }, { channel: 'asc' }],
    });
  }

  async updateTemplate(orgId: string, id: string, dto: { body: string; subject?: string; isActive: boolean }) {
    const template = await this.prisma.notificationTemplate.findFirst({
      where: { id, orgId },
    });
    if (!template) throw new NotFoundException('Шаблон не знайдено');
    return this.prisma.notificationTemplate.update({
      where: { id, orgId },
      data: { body: dto.body, subject: dto.subject, isActive: dto.isActive },
    });
  }

  private renderTemplate(template: string, vars: Record<string, any>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ''));
  }
}
