import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { randomUUID } from 'crypto';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { validatePublicUrl } from '../../common/utils/url-guard';
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

  async create(orgId: string, dto: CreateWebhookDto): Promise<WebhookEndpointResponseDto> {
    // SSRF defense: reject loopback/private/link-local URLs.
    // @IsUrl({ require_tld: false }) on the DTO accepts `http://localhost:6379`
    // which would let a compromised admin pipe webhook payloads to internal
    // Redis/Postgres/cloud-metadata endpoints.
    const urlError = validatePublicUrl(dto.url);
    if (urlError) throw new BadRequestException(urlError);

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

  async findAll(orgId: string): Promise<{ items: WebhookEndpointResponseDto[]; total: number }> {
    const [items, total] = await Promise.all([
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
    // Re-validate URL on update (same SSRF defense as create).
    if (dto.url !== undefined) {
      const urlError = validatePublicUrl(dto.url);
      if (urlError) throw new BadRequestException(urlError);
    }
    // Defense-in-depth: scope by orgId у where (sto-review pattern 2026-05-30
    // soft-delete update without orgId). Eliminate the race-window between
    // findFirst guard and update — cross-tenant id could be mutated otherwise.
    const result = await this.prisma.webhookEndpoint.updateMany({
      where: { id, orgId, deletedAt: null },
      data: dto,
    });
    if (result.count === 0) throw new NotFoundException('Вебхук не знайдено');
    const updated = await this.prisma.webhookEndpoint.findFirstOrThrow({
      where: { id, orgId },
    });
    return this.toDto(updated);
  }

  async remove(orgId: string, id: string): Promise<void> {
    // Defense-in-depth: same pattern as update — atomic soft-delete with orgId
    // guard inside the where. Eliminates a race window between findFirst and update.
    const result = await this.prisma.webhookEndpoint.updateMany({
      where: { id, orgId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (result.count === 0) throw new NotFoundException('Вебхук не знайдено');
  }

  async findDeliveries(
    orgId: string,
    endpointId: string,
  ): Promise<{ items: WebhookDeliveryResponseDto[]; total: number }> {
    // Narrow guard — потрібен лише факт існування + tenant-scope для NotFoundException.
    const ep = await this.prisma.webhookEndpoint.findFirst({
      where: { id: endpointId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!ep) throw new NotFoundException('Вебхук не знайдено');
    const [items, total] = await Promise.all([
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
  async dispatchEvent(orgId: string, event: string, data: object): Promise<void> {
    // Narrow projection — лише ці три поля передаються в Bull job payload.
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: {
        orgId,
        deletedAt: null,
        isActive: true,
        events: { has: event },
      },
      select: { id: true, url: true, secret: true },
      take: 50,
    });

    // Fan out queue.add in parallel — each call is an independent Redis RTT,
    // so sequential await serialised N×(net RTT). Promise.all collapses to one
    // batch of concurrent writes (Bull internally pipelines).
    await Promise.all(
      endpoints.map(ep => {
        // Stable per-dispatch idempotency key. Generated ONCE here and carried in the
        // job payload, so every BullMQ retry of the same job re-sends the SAME id.
        // The receiver can dedup on it → retries after a network blip / remote 5xx do
        // not process the event twice. Must NOT be derived from job.id inside the
        // processor (BullMQ can re-add a job with a new id on some failure paths).
        const deliveryId = randomUUID();
        return this.webhookQueue.add(
          'deliver',
          {
            endpointId: ep.id,
            url: ep.url,
            secret: ep.secret,
            event,
            payload: data,
            deliveryId,
          },
          {
            // Offline-first: ≥10 retries with exponential backoff so transient
            // network outages or remote 5xx errors do not lose webhook events.
            attempts: 10,
            backoff: { type: 'exponential', delay: 60_000 },
            removeOnComplete: 100,
            removeOnFail: 200,
          },
        );
      }),
    );
  }
}
