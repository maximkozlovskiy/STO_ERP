import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { WebhooksService } from './webhooks.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { HostLookup } from '../../common/utils/url-guard';
import {
  publicHostLookup,
  loopbackHostLookup,
  metadataHostLookup,
} from '../../common/testing/host-lookup';

/**
 * WebhooksService — SSRF-перевірка URL після DNS на create/update (BR-SEC-SSRF).
 *
 * guards: BR-SEC-SSRF — зовнішній webhook URL валідується після резолву DNS; публічне ім'я, що
 * веде на приватну/loopback/метадані-адресу, відхиляється з BadRequestException (400) ще до запису
 * ендпоінта. Літеральні приватні адреси блокувались і раніше (validatePublicUrl); тут доводимо саме
 * resolved-гілку (фейковий HostLookup) + що публічна адреса проходить.
 */
describe('WebhooksService — SSRF resolved guard (create/update)', () => {
  let svc: WebhooksService;
  let lookup: HostLookup;
  let prisma: {
    webhookEndpoint: {
      create: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
      findFirstOrThrow: ReturnType<typeof vi.fn>;
    };
  };
  const ORG = 'org-1';

  const createdRow = {
    id: 'wh-1',
    orgId: ORG,
    url: 'https://hooks.example.com/x',
    events: ['WO_STATUS_CHANGED'],
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  beforeEach(() => {
    lookup = publicHostLookup;
    prisma = {
      webhookEndpoint: {
        create: vi.fn().mockResolvedValue(createdRow),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirstOrThrow: vi.fn().mockResolvedValue(createdRow),
      },
    };
    const queue = { add: vi.fn() } as unknown as Queue;
    svc = new WebhooksService(prisma as unknown as PrismaService, queue, (...args) =>
      lookup(...args),
    );
  });

  describe('create', () => {
    it('публічне ім`я → public адреса → створює ендпоінт', async () => {
      lookup = publicHostLookup;
      const res = await svc.create(ORG, {
        url: 'https://hooks.example.com/x',
        events: ['WO_STATUS_CHANGED'],
      });
      expect(res.id).toBe('wh-1');
      expect(prisma.webhookEndpoint.create).toHaveBeenCalledTimes(1);
    });

    it('публічне ім`я → loopback (DNS) → 400, запис НЕ створюється', async () => {
      lookup = loopbackHostLookup;
      await expect(
        svc.create(ORG, { url: 'https://rebind.example/x', events: ['WO_STATUS_CHANGED'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.webhookEndpoint.create).not.toHaveBeenCalled();
    });

    it('публічне ім`я → cloud-metadata (DNS) → 400', async () => {
      lookup = metadataHostLookup;
      await expect(
        svc.create(ORG, { url: 'https://rebind.example/x', events: ['WO_STATUS_CHANGED'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.webhookEndpoint.create).not.toHaveBeenCalled();
    });

    it('літеральний loopback URL → 400 (без DNS)', async () => {
      await expect(
        svc.create(ORG, { url: 'http://127.0.0.1:6379/x', events: ['WO_STATUS_CHANGED'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.webhookEndpoint.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('url відсутній у dto → SSRF-перевірка не запускається, оновлює', async () => {
      lookup = loopbackHostLookup; // навіть із loopback-резолвером: url не передано → не перевіряємо
      const res = await svc.update(ORG, 'wh-1', { isActive: false });
      expect(res.id).toBe('wh-1');
      expect(prisma.webhookEndpoint.updateMany).toHaveBeenCalledTimes(1);
    });

    it('url → loopback (DNS) → 400, updateMany НЕ викликається', async () => {
      lookup = loopbackHostLookup;
      await expect(
        svc.update(ORG, 'wh-1', { url: 'https://rebind.example/x' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.webhookEndpoint.updateMany).not.toHaveBeenCalled();
    });

    it('url → public (DNS) → оновлює', async () => {
      lookup = publicHostLookup;
      const res = await svc.update(ORG, 'wh-1', { url: 'https://hooks.example.com/x' });
      expect(res.id).toBe('wh-1');
      expect(prisma.webhookEndpoint.updateMany).toHaveBeenCalledTimes(1);
    });
  });
});
