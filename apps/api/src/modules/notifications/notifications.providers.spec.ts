import { vi, describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { Queue } from 'bullmq';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationProviderRegistry } from './providers/provider-registry';

/**
 * Phase 3 — контракт verify/config-endpoints (listProviders / verifyProvider /
 * getBranchChannels / upsertBranchChannel). Ці методи мали 0 тестів (test-gap = defect
 * за SKILL.md). Покриваються edge-cases:
 *  - upsert: create-new vs update-existing, apiKey write-only (без ключа → зберігаємо
 *    наявний; з ключем → перезапис), reactivate soft-deleted, branch-not-in-org →
 *    NotFound, unknown provider → BadRequest, provider не підтримує канал → BadRequest,
 *    atomic upsert по @@unique([branchId,channel]) (два "create" → update, не P2002).
 *  - getBranchChannels: apiKey НІКОЛИ не в response (лише hasApiKey), orgId+deletedAt
 *    фільтр, orderBy priority asc.
 *  - verifyProvider: unknown code → NotFound; valid → повертає shape провайдера;
 *    apiKey не логується.
 */
describe('NotificationsService — Phase 3 providers/channels', () => {
  const branchFindFirst = vi.fn();
  const cfgUpsert = vi.fn();
  const cfgFindMany = vi.fn();

  const prisma = {
    garageBranch: { findFirst: branchFindFirst },
    notificationChannelConfig: { upsert: cfgUpsert, findMany: cfgFindMany },
  } as unknown as PrismaService;

  const registryGet = vi.fn();
  const registryList = vi.fn();
  const registry = {
    get: registryGet,
    list: registryList,
  } as unknown as NotificationProviderRegistry;

  const queue = { add: vi.fn() } as unknown as Queue;

  let service: NotificationsService;

  // TurboSMS-подібний provider: SMS + VIBER, БЕЗ EMAIL.
  const turbosms = {
    code: 'turbosms',
    name: 'TurboSMS',
    channels: [NotificationChannel.SMS, NotificationChannel.VIBER],
    verifyCredentials: vi.fn(),
    send: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new NotificationsService(prisma, registry, queue);
  });

  // ─── listProviders ────────────────────────────────────────────────────────
  describe('listProviders', () => {
    it('делегує у registry.list() (метадані без кредів)', () => {
      registryList.mockReturnValue([
        { code: 'turbosms', name: 'TurboSMS', channels: ['SMS', 'VIBER'] },
      ]);
      const res = service.listProviders();
      expect(res).toEqual([{ code: 'turbosms', name: 'TurboSMS', channels: ['SMS', 'VIBER'] }]);
      expect(registryList).toHaveBeenCalledOnce();
    });
  });

  // ─── verifyProvider ───────────────────────────────────────────────────────
  describe('verifyProvider', () => {
    it('невідомий код → NotFoundException', async () => {
      registryGet.mockReturnValue(null);
      await expect(service.verifyProvider('nope', 'k')).rejects.toBeInstanceOf(NotFoundException);
      expect(turbosms.verifyCredentials).not.toHaveBeenCalled();
    });

    it('валідний код → викликає verifyCredentials і повертає його shape', async () => {
      registryGet.mockReturnValue(turbosms);
      turbosms.verifyCredentials.mockResolvedValue({
        valid: true,
        balance: 42,
        senderNames: ['STO ERP'],
      });
      const res = await service.verifyProvider('turbosms', 'secret-key', 'STO ERP');
      expect(res).toEqual({ valid: true, balance: 42, senderNames: ['STO ERP'] });
      expect(turbosms.verifyCredentials).toHaveBeenCalledWith({
        apiKey: 'secret-key',
        senderName: 'STO ERP',
      });
    });

    it('apiKey не потрапляє у логи (verify не логує креди)', async () => {
      const logSpy = vi.spyOn((service as unknown as { logger: { log: unknown } }).logger, 'log');
      const warnSpy = vi.spyOn(
        (service as unknown as { logger: { warn: unknown } }).logger,
        'warn',
      );
      registryGet.mockReturnValue(turbosms);
      turbosms.verifyCredentials.mockResolvedValue({ valid: true });
      await service.verifyProvider('turbosms', 'super-secret-token');
      const allLogged = [...logSpy.mock.calls, ...warnSpy.mock.calls].flat().join(' ');
      expect(allLogged).not.toContain('super-secret-token');
    });
  });

  // ─── getBranchChannels ────────────────────────────────────────────────────
  describe('getBranchChannels', () => {
    it('apiKey НІКОЛИ не в response — лише hasApiKey boolean', async () => {
      cfgFindMany.mockResolvedValue([
        {
          id: 'c1',
          channel: 'SMS',
          provider: 'turbosms',
          enabled: true,
          priority: 0,
          apiKey: 'secret',
          senderName: 'STO',
          updatedAt: new Date(),
        },
        {
          id: 'c2',
          channel: 'VIBER',
          provider: 'turbosms',
          enabled: false,
          priority: 1,
          apiKey: null,
          senderName: null,
          updatedAt: new Date(),
        },
      ]);
      const res = await service.getBranchChannels('org-1', 'br-1');
      expect(res).toHaveLength(2);
      // Жоден об'єкт не має ключа apiKey
      for (const row of res) {
        expect(row).not.toHaveProperty('apiKey');
      }
      expect(res[0]).toMatchObject({ id: 'c1', hasApiKey: true });
      expect(res[1]).toMatchObject({ id: 'c2', hasApiKey: false });
      // Секрет не витік у жодне поле відповіді
      expect(JSON.stringify(res)).not.toContain('secret');
    });

    it('порожній рядок apiKey → hasApiKey=false', async () => {
      cfgFindMany.mockResolvedValue([
        {
          id: 'c1',
          channel: 'SMS',
          provider: 'turbosms',
          enabled: true,
          priority: 0,
          apiKey: '',
          senderName: null,
          updatedAt: new Date(),
        },
      ]);
      const res = await service.getBranchChannels('org-1', 'br-1');
      expect(res[0].hasApiKey).toBe(false);
    });

    it('where фільтрує orgId+branchId+deletedAt:null та orderBy priority asc', async () => {
      cfgFindMany.mockResolvedValue([]);
      await service.getBranchChannels('org-9', 'br-9');
      const arg = cfgFindMany.mock.calls[0][0];
      expect(arg.where).toMatchObject({ orgId: 'org-9', branchId: 'br-9', deletedAt: null });
      expect(arg.orderBy).toEqual({ priority: 'asc' });
      // select НЕ повинен повертати apiKey у "сирому" вигляді назовні — але він читається,
      // щоб побудувати hasApiKey; головне — мапер його видаляє (перевірено вище).
      expect(arg.select).toHaveProperty('apiKey', true);
    });
  });

  // ─── upsertBranchChannel ──────────────────────────────────────────────────
  describe('upsertBranchChannel', () => {
    const dto = {
      channel: NotificationChannel.SMS,
      provider: 'turbosms',
      enabled: true,
      priority: 0,
      apiKey: 'new-key',
      senderName: 'STO',
    };

    it('філія не в org → NotFoundException (провайдер не перевіряється)', async () => {
      branchFindFirst.mockResolvedValue(null);
      await expect(service.upsertBranchChannel('org-1', 'br-x', dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(registryGet).not.toHaveBeenCalled();
      expect(cfgUpsert).not.toHaveBeenCalled();
    });

    it('branch findFirst скоупиться orgId+deletedAt:null', async () => {
      branchFindFirst.mockResolvedValue({ id: 'br-1' });
      registryGet.mockReturnValue(turbosms);
      cfgUpsert.mockResolvedValue({ id: 'row-1' });
      await service.upsertBranchChannel('org-1', 'br-1', dto);
      expect(branchFindFirst.mock.calls[0][0].where).toMatchObject({
        id: 'br-1',
        orgId: 'org-1',
        deletedAt: null,
      });
    });

    it('невідомий провайдер → BadRequestException', async () => {
      branchFindFirst.mockResolvedValue({ id: 'br-1' });
      registryGet.mockReturnValue(null);
      await expect(
        service.upsertBranchChannel('org-1', 'br-1', { ...dto, provider: 'ghost' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(cfgUpsert).not.toHaveBeenCalled();
    });

    it('провайдер не підтримує канал (VIBER-only provider без SMS) → BadRequestException', async () => {
      branchFindFirst.mockResolvedValue({ id: 'br-1' });
      // provider який уміє лише EMAIL — не підтримує SMS із dto
      registryGet.mockReturnValue({ ...turbosms, channels: [NotificationChannel.EMAIL] });
      await expect(service.upsertBranchChannel('org-1', 'br-1', dto)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(cfgUpsert).not.toHaveBeenCalled();
    });

    it('turbosms не підтримує EMAIL → BadRequest для EMAIL-каналу', async () => {
      branchFindFirst.mockResolvedValue({ id: 'br-1' });
      registryGet.mockReturnValue(turbosms);
      await expect(
        service.upsertBranchChannel('org-1', 'br-1', {
          ...dto,
          channel: NotificationChannel.EMAIL,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('happy: upsert по @@unique([branchId,channel]), reactivate у update (deletedAt:null)', async () => {
      branchFindFirst.mockResolvedValue({ id: 'br-1' });
      registryGet.mockReturnValue(turbosms);
      cfgUpsert.mockResolvedValue({ id: 'row-1' });

      const res = await service.upsertBranchChannel('org-1', 'br-1', dto);
      expect(res).toEqual({ id: 'row-1' });

      const arg = cfgUpsert.mock.calls[0][0];
      expect(arg.where).toEqual({ branchId_channel: { branchId: 'br-1', channel: 'SMS' } });
      // update-гілка реактивує soft-deleted рядок
      expect(arg.update.deletedAt).toBeNull();
      // create-гілка містить orgId (tenant) з параметра
      expect(arg.create).toMatchObject({ orgId: 'org-1', branchId: 'br-1', channel: 'SMS' });
    });

    it('apiKey write-only: PATCH БЕЗ apiKey → upsert НЕ містить apiKey (наявний ключ не стирається)', async () => {
      branchFindFirst.mockResolvedValue({ id: 'br-1' });
      registryGet.mockReturnValue(turbosms);
      cfgUpsert.mockResolvedValue({ id: 'row-1' });

      const { apiKey: _omit, ...noKeyDto } = dto;
      void _omit;
      await service.upsertBranchChannel('org-1', 'br-1', noKeyDto);

      const arg = cfgUpsert.mock.calls[0][0];
      expect(arg.update).not.toHaveProperty('apiKey');
      expect(arg.create).not.toHaveProperty('apiKey');
    });

    it('apiKey write-only: PATCH з ПОРОЖНІМ apiKey ("") → не перезаписує (зберігаємо наявний)', async () => {
      branchFindFirst.mockResolvedValue({ id: 'br-1' });
      registryGet.mockReturnValue(turbosms);
      cfgUpsert.mockResolvedValue({ id: 'row-1' });

      await service.upsertBranchChannel('org-1', 'br-1', { ...dto, apiKey: '' });

      const arg = cfgUpsert.mock.calls[0][0];
      expect(arg.update).not.toHaveProperty('apiKey');
      expect(arg.create).not.toHaveProperty('apiKey');
    });

    it('apiKey write-only: PATCH з НОВИМ apiKey → перезапис у обидвох гілках', async () => {
      branchFindFirst.mockResolvedValue({ id: 'br-1' });
      registryGet.mockReturnValue(turbosms);
      cfgUpsert.mockResolvedValue({ id: 'row-1' });

      await service.upsertBranchChannel('org-1', 'br-1', { ...dto, apiKey: 'rotated-key' });

      const arg = cfgUpsert.mock.calls[0][0];
      expect(arg.update.apiKey).toBe('rotated-key');
      expect(arg.create.apiKey).toBe('rotated-key');
    });

    it('create-дефолти: enabled?? true, priority?? 0 коли не надіслані', async () => {
      branchFindFirst.mockResolvedValue({ id: 'br-1' });
      registryGet.mockReturnValue(turbosms);
      cfgUpsert.mockResolvedValue({ id: 'row-1' });

      await service.upsertBranchChannel('org-1', 'br-1', {
        channel: NotificationChannel.SMS,
        provider: 'turbosms',
      });

      const arg = cfgUpsert.mock.calls[0][0];
      expect(arg.create.enabled).toBe(true);
      expect(arg.create.priority).toBe(0);
    });

    it('atomic: два "create" на той самий (branchId,channel) резолвляться в update, не P2002', async () => {
      branchFindFirst.mockResolvedValue({ id: 'br-1' });
      registryGet.mockReturnValue(turbosms);
      // Prisma upsert = INSERT ... ON CONFLICT DO UPDATE → другий виклик не кидає P2002,
      // а оновлює наявний рядок (той самий id). Мок імітує це: обидва повертають row-1.
      cfgUpsert.mockResolvedValue({ id: 'row-1' });

      const a = await service.upsertBranchChannel('org-1', 'br-1', dto);
      const b = await service.upsertBranchChannel('org-1', 'br-1', dto);
      expect(a).toEqual({ id: 'row-1' });
      expect(b).toEqual({ id: 'row-1' });
      // Обидва пішли через upsert (жодного окремого create → жодного шансу на P2002)
      expect(cfgUpsert).toHaveBeenCalledTimes(2);
      for (const call of cfgUpsert.mock.calls) {
        expect(call[0].where).toEqual({ branchId_channel: { branchId: 'br-1', channel: 'SMS' } });
      }
    });
  });
});
