/**
 * NotificationsService.activateProvider
 *
 * Виділено з `notifications.service.spec.ts` (був 941 рядок, 4 незалежні top-level
 * describe) 2026-10-05. Кейси перенесені ДОСЛІВНО, назви describe не змінені — інакше
 * `fullName` у test-baseline.json розійшовся б.
 *
 * Цей модуль НЕ використовує Nest DI: сервіс конструюється напряму
 * (`new NotificationsService(prisma, registry, queue)`), тож спільної фікстури не потребує.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import type { Queue } from 'bullmq';
import { NotificationsService } from './notifications.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { NotificationProviderRegistry } from './providers/provider-registry';

describe('NotificationsService.activateProvider', () => {
  interface Row {
    id: string;
    orgId: string;
    branchId: string;
    provider: string;
    channel: NotificationChannel;
    enabled: boolean;
    deletedAt: Date | null;
  }

  const branchFindFirst = vi.fn();
  const updateMany = vi.fn();
  const registryGet = vi.fn();

  // In-memory сховище рядків конфігів каналів.
  let store: Row[];

  // Матчер where-клозу updateMany проти рядка сховища (моделює Prisma-семантику).
  const matches = (where: Record<string, unknown>, r: Row): boolean => {
    if (where.orgId !== undefined && r.orgId !== where.orgId) return false;
    if (where.branchId !== undefined && r.branchId !== where.branchId) return false;
    if (where.deletedAt !== undefined && r.deletedAt !== where.deletedAt) return false;
    const prov = where.provider as { not?: string } | string | undefined;
    if (typeof prov === 'string' && r.provider !== prov) return false;
    if (prov && typeof prov === 'object' && 'not' in prov && r.provider === prov.not) return false;
    return true;
  };

  const prisma = {
    garageBranch: { findFirst: branchFindFirst },
    notificationChannelConfig: { updateMany },
    // Масив-форма: усі updateMany-проміси створюються ДО $transaction → просто Promise.all.
    $transaction: vi.fn().mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops)),
  } as unknown as PrismaService;

  const queue = { add: vi.fn() } as unknown as Queue;
  const registry = { get: registryGet, list: vi.fn() } as unknown as NotificationProviderRegistry;

  let service: NotificationsService;

  beforeEach(() => {
    vi.clearAllMocks();
    registryGet.mockReturnValue({ code: 'turbosms' }); // провайдер відомий за замовч.
    branchFindFirst.mockResolvedValue({ id: 'br-1' }); // філія у складі org
    // updateMany мутує store згідно where+data, повертає {count}.
    updateMany.mockImplementation(
      async ({ where, data }: { where: Record<string, unknown>; data: { enabled: boolean } }) => {
        let count = 0;
        for (const r of store) {
          if (matches(where, r)) {
            r.enabled = data.enabled;
            count++;
          }
        }
        return { count };
      },
    );
    service = new NotificationsService(prisma, registry, queue);
  });

  const enabledProviders = (rows: Row[]): string[] => [
    ...new Set(rows.filter(r => r.enabled).map(r => r.provider)),
  ];

  // ─── Валідація ────────────────────────────────────────────────────────────
  it('невідомий провайдер → BadRequestException (не чіпає БД)', async () => {
    registryGet.mockReturnValue(null);
    store = [];
    await expect(service.activateProvider('org-1', 'br-1', 'nope')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(branchFindFirst).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('філія не в межах org → NotFoundException (не чіпає БД)', async () => {
    branchFindFirst.mockResolvedValue(null);
    store = [];
    await expect(service.activateProvider('org-1', 'br-x', 'turbosms')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // Перевірка філії — саме org-scoped (orgId + deletedAt:null).
    expect(branchFindFirst).toHaveBeenCalledWith({
      where: { id: 'br-x', orgId: 'org-1', deletedAt: null },
      select: { id: true },
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  // ─── Happy-path + exclusivity ────────────────────────────────────────────
  it('активація B коли активний A → лишається enabled ЛИШЕ B (усі канали B)', async () => {
    store = [
      {
        id: '1',
        orgId: 'org-1',
        branchId: 'br-1',
        provider: 'turbosms',
        channel: NotificationChannel.SMS,
        enabled: true,
        deletedAt: null,
      }, // A active
      {
        id: '2',
        orgId: 'org-1',
        branchId: 'br-1',
        provider: 'turbosms',
        channel: NotificationChannel.VIBER,
        enabled: true,
        deletedAt: null,
      },
      {
        id: '3',
        orgId: 'org-1',
        branchId: 'br-1',
        provider: 'esputnik',
        channel: NotificationChannel.SMS,
        enabled: false,
        deletedAt: null,
      },
      {
        id: '4',
        orgId: 'org-1',
        branchId: 'br-1',
        provider: 'esputnik',
        channel: NotificationChannel.VIBER,
        enabled: false,
        deletedAt: null,
      },
    ];

    const res = await service.activateProvider('org-1', 'br-1', 'esputnik');

    expect(res).toEqual({ activeProvider: 'esputnik' });
    expect(enabledProviders(store)).toEqual(['esputnik']); // рівно один провайдер
    // Усі канали esputnik enabled; усі turbosms вимкнені.
    expect(store.filter(r => r.provider === 'esputnik').every(r => r.enabled)).toBe(true);
    expect(store.filter(r => r.provider === 'turbosms').every(r => !r.enabled)).toBe(true);
  });

  it('legacy: ДВА провайдери enabled одночасно → активація одного лишає enabled ЛИШЕ його', async () => {
    store = [
      {
        id: '1',
        orgId: 'org-1',
        branchId: 'br-1',
        provider: 'turbosms',
        channel: NotificationChannel.SMS,
        enabled: true,
        deletedAt: null,
      },
      {
        id: '2',
        orgId: 'org-1',
        branchId: 'br-1',
        provider: 'esputnik',
        channel: NotificationChannel.VIBER,
        enabled: true,
        deletedAt: null,
      }, // «брудний» стан
    ];

    await service.activateProvider('org-1', 'br-1', 'turbosms');

    expect(enabledProviders(store)).toEqual(['turbosms']);
    expect(store.find(r => r.id === '2')!.enabled).toBe(false);
  });

  // ─── Tenant isolation (найгірший сценарій — cross-org) ─────────────────────
  it('обидва updateMany несуть orgId+branchId (both where-clauses tenant-scoped)', async () => {
    store = [
      {
        id: '1',
        orgId: 'org-1',
        branchId: 'br-1',
        provider: 'turbosms',
        channel: NotificationChannel.SMS,
        enabled: false,
        deletedAt: null,
      },
    ];

    await service.activateProvider('org-1', 'br-1', 'turbosms');

    expect(updateMany).toHaveBeenCalledTimes(2);
    const [disableCall, enableCall] = updateMany.mock.calls;
    // #1 — вимкнути інших: orgId+branchId+deletedAt+provider{not}
    expect(disableCall[0].where).toMatchObject({
      orgId: 'org-1',
      branchId: 'br-1',
      deletedAt: null,
      provider: { not: 'turbosms' },
    });
    expect(disableCall[0].data).toEqual({ enabled: false });
    // #2 — увімкнути активного: orgId+branchId+deletedAt+provider
    expect(enableCall[0].where).toMatchObject({
      orgId: 'org-1',
      branchId: 'br-1',
      deletedAt: null,
      provider: 'turbosms',
    });
    expect(enableCall[0].data).toEqual({ enabled: true });
  });

  it('канали ІНШОЇ org (той самий provider/branchId колізія) НЕ чіпаються', async () => {
    // Другий org має рядок з тим самим branchId-значенням і providerCode — cross-org leak
    // спрацював би якщо where забуде orgId. Активуємо для org-1.
    store = [
      {
        id: 'own-off',
        orgId: 'org-1',
        branchId: 'br-1',
        provider: 'turbosms',
        channel: NotificationChannel.SMS,
        enabled: false,
        deletedAt: null,
      },
      {
        id: 'own-other',
        orgId: 'org-1',
        branchId: 'br-1',
        provider: 'esputnik',
        channel: NotificationChannel.SMS,
        enabled: true,
        deletedAt: null,
      },
      // Чужий org — має лишитись НЕДОТОРКАНИМ (обидва прапорці).
      {
        id: 'foreign-same-prov',
        orgId: 'org-2',
        branchId: 'br-1',
        provider: 'turbosms',
        channel: NotificationChannel.SMS,
        enabled: false,
        deletedAt: null,
      },
      {
        id: 'foreign-other',
        orgId: 'org-2',
        branchId: 'br-1',
        provider: 'esputnik',
        channel: NotificationChannel.SMS,
        enabled: true,
        deletedAt: null,
      },
    ];

    await service.activateProvider('org-1', 'br-1', 'turbosms');

    // org-1: turbosms enabled, esputnik disabled.
    expect(store.find(r => r.id === 'own-off')!.enabled).toBe(true);
    expect(store.find(r => r.id === 'own-other')!.enabled).toBe(false);
    // org-2: без змін (turbosms лишився false, esputnik лишився true).
    expect(store.find(r => r.id === 'foreign-same-prov')!.enabled).toBe(false);
    expect(store.find(r => r.id === 'foreign-other')!.enabled).toBe(true);
  });

  it('soft-deleted канали (deletedAt≠null) НЕ реактивуються активацією', async () => {
    store = [
      {
        id: 'live',
        orgId: 'org-1',
        branchId: 'br-1',
        provider: 'turbosms',
        channel: NotificationChannel.SMS,
        enabled: false,
        deletedAt: null,
      },
      {
        id: 'dead',
        orgId: 'org-1',
        branchId: 'br-1',
        provider: 'turbosms',
        channel: NotificationChannel.VIBER,
        enabled: false,
        deletedAt: new Date(),
      },
    ];

    await service.activateProvider('org-1', 'br-1', 'turbosms');

    expect(store.find(r => r.id === 'live')!.enabled).toBe(true);
    expect(store.find(r => r.id === 'dead')!.enabled).toBe(false); // deletedAt виключає з where
  });

  // ─── Empty-state (backend idempotent by design; guard — фронтовий) ──────────
  it('провайдер БЕЗ каналів → обидва updateMany матчать 0 рядків, повертає {activeProvider}, НЕ кидає', async () => {
    store = [
      // Є канали лише іншого провайдера; активуємо провайдер без жодного каналу.
      {
        id: '1',
        orgId: 'org-1',
        branchId: 'br-1',
        provider: 'esputnik',
        channel: NotificationChannel.SMS,
        enabled: true,
        deletedAt: null,
      },
    ];

    const res = await service.activateProvider('org-1', 'br-1', 'turbosms');

    expect(res).toEqual({ activeProvider: 'turbosms' });
    // Enable-гілка матчить 0 (немає turbosms-каналів); disable-гілка вимкнула esputnik.
    const enableCall = updateMany.mock.calls[1];
    const enableCount = await updateMany.mock.results[1].value;
    expect(enableCall[0].where.provider).toBe('turbosms');
    expect(enableCount.count).toBe(0);
    // Нічого не enabled (idempotent no-op на увімкнення) — інших провайдерів вимкнуто.
    expect(enabledProviders(store)).toEqual([]);
  });

  it('порожнє сховище зовсім → 0/0 рядків, {activeProvider}, без throw', async () => {
    store = [];
    await expect(service.activateProvider('org-1', 'br-1', 'turbosms')).resolves.toEqual({
      activeProvider: 'turbosms',
    });
  });
});
