import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateWebhookDto,
  UpdateWebhookDto,
  WebhookEndpointResponseDto,
  WebhookDeliveryResponseDto,
} from './webhooks.dto';

@Injectable()
export class WebhooksService {
  constructor(
    private prisma: PrismaService,
    @InjectQueue('outbound-webhook') private webhookQueue: Queue,
  ) {}

  private toDto(e: {
    id: string;
    orgId: string;
    url: string;
    events: string[];
    isActive: boolean;
    createdAt: Date;
  }): WebhookEndpointResponseDto {
    return {
      id: e.id,
      orgId: e.orgId,
      url: e.url,
      events: e.events,
      isActive: e.isActive,
      createdAt: e.createdAt.toISOString(),
    };
  }

  async create(
    orgId: string,
    dto: CreateWebhookDto,
  ): Promise<WebhookEndpointResponseDto> {
    const e = await this.prisma.webhookEndpoint.create({
      data: {
        orgId,
        url: dto.url,
        secret: dto.secret ?? '',
        events: dto.events,
      },
    });
    return this.toDto(e);
  }

  async findAll(
    orgId: string,
  ): Promise<{ items: WebhookEndpointResponseDto[]; total: number }> {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.webhookEndpoint.findMany({
        where: { orgId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.webhookEndpoint.count({ where: { orgId, deletedAt: null } }),
    ]);
    return { items: items.map(e => this.toDto(e)), total };
  }

  async update(
    orgId: string,
    id: string,
    dto: UpdateWebhookDto,
  ): Promise<WebhookEndpointResponseDto> {
    const e = await this.prisma.webhookEndpoint.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!e) throw new NotFoundException('Вебхук не знайдено');
    const updated = await this.prisma.webhookEndpoint.update({
      where: { id },
      data: dto,
    });
    return this.toDto(updated);
  }

  async remove(orgId: string, id: string): Promise<void> {
    const e = await this.prisma.webhookEndpoint.findFirst({
      where: { id, orgId, deletedAt: null },
    });
    if (!e) throw new NotFoundException('Вебхук не знайдено');
    await this.prisma.webhookEndpoint.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async findDeliveries(
    orgId: string,
    endpointId: string,
  ): Promise<{ items: WebhookDeliveryResponseDto[]; total: number }> {
    const ep = await this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, orgId, deletedAt: null },
    });
    if (!ep) throw new NotFoundException('Вебхук не знайдено');
    const [items, total] = await this.prisma.$transaction([
      this.prisma.webhookDelivery.findMany({
        where: { endpointId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.webhookDelivery.count({ where: { endpointId } }),
    ]);
    return {
      items: items.map(d => ({
        id: d.id,
        event: d.event,
        status: d.status,
        attempts: d.attempts,
        responseCode: d.responseCode ?? null,
        createdAt: d.createdAt.toISOString(),
      })),
      total,
    };
  }

  /**
   * Dispatch a webhook event to all active matching endpoints.
   * Called from other services (WorkOrders, Payments, Inventory).
   */
  async dispatchEvent(
    orgId: string,
    event: string,
    data: object,
  ): Promise<void> {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: {
        orgId,
        deletedAt: null,
        isActive: true,
        events: { has: event },
      },
      take: 50,
    });

    for (const ep of endpoints) {
      await this.webhookQueue.add(
        'deliver',
        {
          endpointId: ep.id,
          url: ep.url,
          secret: ep.secret,
          event,
          payload: data,
        },
        {
          attempts: 5,
          backoff: { type: 'exponential', delay: 60_000 },
          removeOnComplete: 100,
          removeOnFail: 200,
        },
      );
    }
  }
}
