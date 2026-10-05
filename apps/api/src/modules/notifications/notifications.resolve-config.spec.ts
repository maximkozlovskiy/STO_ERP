/**
 * NotificationsService.resolveConfig — ланцюг fallback + EMAIL subject
 *
 * Виділено з `notifications.service.spec.ts` (був 941 рядок, 4 незалежні top-level
 * describe) 2026-10-05. Кейси перенесені ДОСЛІВНО, назви describe не змінені — інакше
 * `fullName` у test-baseline.json розійшовся б.
 *
 * Цей модуль НЕ використовує Nest DI: сервіс конструюється напряму
 * (`new NotificationsService(prisma, registry, queue)`), тож спільної фікстури не потребує.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { NotificationChannel } from '@prisma/client';
import type { Queue } from 'bullmq';
import { NotificationsService } from './notifications.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { NotificationProviderRegistry } from './providers/provider-registry';

describe('NotificationsService.resolveConfig', () => {
  const channelConfigFindMany = vi.fn();
  const templateFindMany = vi.fn();
  const branchSettingsFindFirst = vi.fn();
  const templateFindFirst = vi.fn();

  const prisma = {
    notificationChannelConfig: { findMany: channelConfigFindMany },
    notificationTemplate: { findMany: templateFindMany, findFirst: templateFindFirst },
    branchSettings: { findFirst: branchSettingsFindFirst },
  } as unknown as PrismaService;

  const queueAdd = vi.fn().mockResolvedValue({});
  const queue = { add: queueAdd } as unknown as Queue;
  const registry = { get: vi.fn(), list: vi.fn() } as unknown as NotificationProviderRegistry;

  let service: NotificationsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new NotificationsService(prisma, registry, queue);
  });

  const cfgRow = (over: Partial<Record<string, unknown>> = {}) => ({
    channel: NotificationChannel.VIBER,
    provider: 'turbosms',
    apiKey: 'tok-viber',
    senderName: 'STO',
    ...over,
  });

  it('будує ланцюг з config-рядків (priority ASC) із per-канал шаблоном', async () => {
    channelConfigFindMany.mockResolvedValue([
      cfgRow({ channel: NotificationChannel.VIBER }),
      cfgRow({ channel: NotificationChannel.SMS, apiKey: 'tok-sms' }),
    ]);
    templateFindMany.mockResolvedValue([
      { channel: NotificationChannel.VIBER, body: 'viber-тіло' },
      { channel: NotificationChannel.SMS, body: 'sms-тіло' },
    ]);

    const cfg = await service.resolveConfig('org-1', 'br-1', 'WO_COMPLETED');

    expect(cfg).not.toBeNull();
    expect(cfg!.channels).toHaveLength(2);
    expect(cfg!.channels[0]).toMatchObject({
      channel: NotificationChannel.VIBER,
      templateBody: 'viber-тіло',
    });
    expect(cfg!.channels[1]).toMatchObject({
      channel: NotificationChannel.SMS,
      templateBody: 'sms-тіло',
    });
    // legacy-гілка НЕ читається коли є config-рядки
    expect(branchSettingsFindFirst).not.toHaveBeenCalled();
  });

  // Edge case 5: після ексклюзивної активації DB-запит enabled:true повертає канали ЛИШЕ
  // одного провайдера → resolveConfig ніколи не змішує провайдерів у fallback-ланцюзі.
  it('post-activation: enabled:true повертає канали ОДНОГО провайдера → ланцюг однопровайдерний', async () => {
    // Модель пост-активаційного стану turbosms: DB віддає лише enabled turbosms-рядки
    // (esputnik вимкнено активацією → where enabled:true його не бачить).
    channelConfigFindMany.mockResolvedValue([
      cfgRow({ channel: NotificationChannel.SMS, provider: 'turbosms', apiKey: 'k1' }),
      cfgRow({ channel: NotificationChannel.VIBER, provider: 'turbosms', apiKey: 'k2' }),
    ]);
    templateFindMany.mockResolvedValue([
      { channel: NotificationChannel.SMS, body: 's' },
      { channel: NotificationChannel.VIBER, body: 'v' },
    ]);

    const cfg = await service.resolveConfig('org-1', 'br-1', 'WO_COMPLETED');

    expect(cfg).not.toBeNull();
    const providers = [...new Set(cfg!.channels.map(c => c.provider))];
    expect(providers).toEqual(['turbosms']); // рівно один провайдер у ланцюзі
    // Запит справді фільтрує enabled:true (лише активний провайдер потрапляє у вибірку).
    expect(channelConfigFindMany.mock.calls[0][0].where).toMatchObject({ enabled: true });
  });

  it('config findMany фільтрує enabled+apiKey NOT NULL+deletedAt=null та orderBy priority asc', async () => {
    channelConfigFindMany.mockResolvedValue([cfgRow({ channel: NotificationChannel.SMS })]);
    templateFindMany.mockResolvedValue([{ channel: NotificationChannel.SMS, body: 'b' }]);

    await service.resolveConfig('org-1', 'br-1', 'WO_COMPLETED');

    const arg = channelConfigFindMany.mock.calls[0][0];
    expect(arg.where).toMatchObject({
      orgId: 'org-1',
      branchId: 'br-1',
      enabled: true,
      deletedAt: null,
      apiKey: { not: null },
    });
    expect(arg.orderBy).toEqual({ priority: 'asc' });
  });

  it('канал без активного шаблону тихо пропускається (fallback перескочить на наступний)', async () => {
    channelConfigFindMany.mockResolvedValue([
      cfgRow({ channel: NotificationChannel.VIBER }),
      cfgRow({ channel: NotificationChannel.SMS, apiKey: 'tok-sms' }),
    ]);
    // Шаблон лише для SMS — VIBER має бути відкинутий
    templateFindMany.mockResolvedValue([{ channel: NotificationChannel.SMS, body: 'sms-тіло' }]);

    const cfg = await service.resolveConfig('org-1', 'br-1', 'WO_COMPLETED');

    expect(cfg).not.toBeNull();
    expect(cfg!.channels).toHaveLength(1);
    expect(cfg!.channels[0].channel).toBe(NotificationChannel.SMS);
  });

  it('жоден канал не має шаблону → null (batch-abort), без throw', async () => {
    channelConfigFindMany.mockResolvedValue([
      cfgRow({ channel: NotificationChannel.VIBER }),
      cfgRow({ channel: NotificationChannel.SMS }),
    ]);
    templateFindMany.mockResolvedValue([]); // жодного активного шаблону

    await expect(service.resolveConfig('org-1', 'br-1', 'WO_COMPLETED')).resolves.toBeNull();
    // legacy-гілка НЕ активується (config-рядки існують)
    expect(branchSettingsFindFirst).not.toHaveBeenCalled();
  });

  it('config-рядок enabled=true але apiKey NULL виключається DB-запитом → legacy fallback без крашу', async () => {
    // where apiKey:{not:null} відкидає рядок з NULL apiKey → findMany повертає []
    channelConfigFindMany.mockResolvedValue([]);
    branchSettingsFindFirst.mockResolvedValue({
      smsEnabled: true,
      smsApiKey: 'legacy-key',
      smsProvider: 'turbosms',
      smsSenderName: 'STO',
    });
    templateFindFirst.mockResolvedValue({ body: 'legacy-sms-тіло' });

    const cfg = await service.resolveConfig('org-1', 'br-1', 'FOLLOWUP_REMINDER');

    expect(cfg).not.toBeNull();
    expect(cfg!.channels).toHaveLength(1);
    expect(cfg!.channels[0]).toMatchObject({
      channel: NotificationChannel.SMS,
      provider: 'turbosms',
      apiKey: 'legacy-key',
      templateBody: 'legacy-sms-тіло',
    });
  });

  it('LEGACY: немає config-рядків, але BranchSettings.smsEnabled+smsApiKey → одноканальний SMS', async () => {
    channelConfigFindMany.mockResolvedValue([]);
    branchSettingsFindFirst.mockResolvedValue({
      smsEnabled: true,
      smsApiKey: 'k',
      smsProvider: null, // → COALESCE 'turbosms'
      smsSenderName: null, // → 'STO ERP'
    });
    templateFindFirst.mockResolvedValue({ body: 'тіло' });

    const cfg = await service.resolveConfig('org-1', 'br-1', 'FOLLOWUP_REMINDER');

    expect(cfg!.channels).toEqual([
      {
        channel: NotificationChannel.SMS,
        provider: 'turbosms',
        apiKey: 'k',
        senderName: 'STO ERP',
        templateBody: 'тіло',
      },
    ]);
  });

  it('LEGACY: smsEnabled=false → null', async () => {
    channelConfigFindMany.mockResolvedValue([]);
    branchSettingsFindFirst.mockResolvedValue({ smsEnabled: false, smsApiKey: 'k' });
    templateFindFirst.mockResolvedValue({ body: 'тіло' });

    await expect(service.resolveConfig('org-1', 'br-1', 'FOLLOWUP_REMINDER')).resolves.toBeNull();
  });

  it('LEGACY: BranchSettings є, smsApiKey null → null (немає крашу)', async () => {
    channelConfigFindMany.mockResolvedValue([]);
    branchSettingsFindFirst.mockResolvedValue({ smsEnabled: true, smsApiKey: null });
    templateFindFirst.mockResolvedValue({ body: 'тіло' });

    await expect(service.resolveConfig('org-1', 'br-1', 'FOLLOWUP_REMINDER')).resolves.toBeNull();
  });

  it('LEGACY: BranchSettings налаштовано, але шаблон SMS відсутній → null', async () => {
    channelConfigFindMany.mockResolvedValue([]);
    branchSettingsFindFirst.mockResolvedValue({ smsEnabled: true, smsApiKey: 'k' });
    templateFindFirst.mockResolvedValue(null);

    await expect(service.resolveConfig('org-1', 'br-1', 'FOLLOWUP_REMINDER')).resolves.toBeNull();
  });

  it('LEGACY: немає жодного BranchSettings-рядка → null (branchSettings=null)', async () => {
    channelConfigFindMany.mockResolvedValue([]);
    branchSettingsFindFirst.mockResolvedValue(null);
    templateFindFirst.mockResolvedValue(null);

    await expect(service.resolveConfig('org-1', 'br-1', 'FOLLOWUP_REMINDER')).resolves.toBeNull();
  });

  it('senderName відсутній у config-рядку → дефолт "STO ERP"', async () => {
    channelConfigFindMany.mockResolvedValue([
      cfgRow({ channel: NotificationChannel.SMS, senderName: null }),
    ]);
    templateFindMany.mockResolvedValue([{ channel: NotificationChannel.SMS, body: 'b' }]);

    const cfg = await service.resolveConfig('org-1', 'br-1', 'WO_COMPLETED');
    expect(cfg!.channels[0].senderName).toBe('STO ERP');
  });

  // externalTemplateId: канал без локального шаблону придатний ЛИШЕ якщо провайдер шле його
  // через шаблон (templateChannels). Інакше inline-провайдер надіслав би порожній текст.
  it('externalTemplateId + template-провайдер (eSputnik VIBER) без локального шаблону → канал включено', async () => {
    channelConfigFindMany.mockResolvedValue([
      cfgRow({
        channel: NotificationChannel.VIBER,
        provider: 'esputnik',
        externalTemplateId: 'tpl-42',
      }),
    ]);
    templateFindMany.mockResolvedValue([]); // локального шаблону немає — текст у кабінеті eSputnik
    (registry.get as ReturnType<typeof vi.fn>).mockReturnValue({
      code: 'esputnik',
      templateChannels: [NotificationChannel.VIBER, NotificationChannel.TELEGRAM],
    });

    const cfg = await service.resolveConfig('org-1', 'br-1', 'WO_COMPLETED');
    expect(cfg).not.toBeNull();
    expect(cfg!.channels).toHaveLength(1);
    expect(cfg!.channels[0]).toMatchObject({
      channel: NotificationChannel.VIBER,
      externalTemplateId: 'tpl-42',
      templateBody: '', // порожній — текст живе у шаблоні провайдера
    });
  });

  it('externalTemplateId + inline-провайдер (turbosms VIBER) без локального шаблону → канал ВИКЛЮЧЕНО (anti empty-send)', async () => {
    channelConfigFindMany.mockResolvedValue([
      cfgRow({
        channel: NotificationChannel.VIBER,
        provider: 'turbosms',
        externalTemplateId: 'tpl-x',
      }),
    ]);
    templateFindMany.mockResolvedValue([]);
    // turbosms не має templateChannels → VIBER для нього inline → канал не придатний.
    (registry.get as ReturnType<typeof vi.fn>).mockReturnValue({ code: 'turbosms' });

    await expect(service.resolveConfig('org-1', 'br-1', 'WO_COMPLETED')).resolves.toBeNull();
  });

  it('eSputnik VIBER БЕЗ externalTemplateId і без локального шаблону → канал ВИКЛЮЧЕНО (нема джерела тексту)', async () => {
    channelConfigFindMany.mockResolvedValue([
      cfgRow({
        channel: NotificationChannel.VIBER,
        provider: 'esputnik',
        externalTemplateId: null, // template-провайдер, але шаблон НЕ вказано
      }),
    ]);
    templateFindMany.mockResolvedValue([]); // локального шаблону теж нема
    (registry.get as ReturnType<typeof vi.fn>).mockReturnValue({
      code: 'esputnik',
      templateChannels: [NotificationChannel.VIBER, NotificationChannel.TELEGRAM],
    });

    // Без externalTemplateId І без локального шаблону — жодного джерела тексту → пропуск → null.
    await expect(service.resolveConfig('org-1', 'br-1', 'WO_COMPLETED')).resolves.toBeNull();
  });

  it('eSputnik SMS з externalTemplateId (випадково) але без локального шаблону → канал ВИКЛЮЧЕНО (SMS inline, не в templateChannels)', async () => {
    channelConfigFindMany.mockResolvedValue([
      cfgRow({
        channel: NotificationChannel.SMS,
        provider: 'esputnik',
        externalTemplateId: 'tpl-stray', // template-id на inline SMS-каналі (обхід upsert-guard)
      }),
    ]);
    templateFindMany.mockResolvedValue([]); // локального SMS-шаблону нема
    (registry.get as ReturnType<typeof vi.fn>).mockReturnValue({
      code: 'esputnik',
      // SMS НЕ входить у templateChannels eSputnik → для SMS канал inline → потрібен локальний текст.
      templateChannels: [NotificationChannel.VIBER, NotificationChannel.TELEGRAM],
    });

    // SMS inline: externalTemplateId ігнорується resolveConfig-ом → нема тексту → пропуск → null.
    // (Інакше esputnik.send для SMS відправив би ПОРОЖНІЙ inline-текст.)
    await expect(service.resolveConfig('org-1', 'br-1', 'WO_COMPLETED')).resolves.toBeNull();
  });

  it('eSputnik TELEGRAM з externalTemplateId без локального шаблону → канал ВКЛЮЧЕНО (template-channel)', async () => {
    channelConfigFindMany.mockResolvedValue([
      cfgRow({
        channel: NotificationChannel.TELEGRAM,
        provider: 'esputnik',
        externalTemplateId: 'tpl-tg',
      }),
    ]);
    templateFindMany.mockResolvedValue([]);
    (registry.get as ReturnType<typeof vi.fn>).mockReturnValue({
      code: 'esputnik',
      templateChannels: [NotificationChannel.VIBER, NotificationChannel.TELEGRAM],
    });

    const cfg = await service.resolveConfig('org-1', 'br-1', 'WO_COMPLETED');
    expect(cfg).not.toBeNull();
    expect(cfg!.channels).toHaveLength(1);
    expect(cfg!.channels[0]).toMatchObject({
      channel: NotificationChannel.TELEGRAM,
      externalTemplateId: 'tpl-tg',
      templateBody: '',
    });
  });
});

describe('NotificationsService.resolveConfig (EMAIL subject)', () => {
  const channelConfigFindMany = vi.fn();
  const templateFindMany = vi.fn();
  const prisma = {
    notificationChannelConfig: { findMany: channelConfigFindMany },
    notificationTemplate: { findMany: templateFindMany, findFirst: vi.fn() },
    branchSettings: { findFirst: vi.fn() },
  } as unknown as PrismaService;
  const queue = { add: vi.fn() } as unknown as Queue;
  const registry = { get: vi.fn(), list: vi.fn() } as unknown as NotificationProviderRegistry;
  let service: NotificationsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new NotificationsService(prisma, registry, queue);
  });

  it('EMAIL-канал з локальним шаблоном (body+subject) → templateBody+templateSubject у config', async () => {
    channelConfigFindMany.mockResolvedValue([
      {
        channel: NotificationChannel.EMAIL,
        provider: 'smtp',
        apiKey: 'smtp-json',
        senderName: 'СТО <sto@ukr.net>',
        externalTemplateId: null,
      },
    ]);
    templateFindMany.mockResolvedValue([
      {
        channel: NotificationChannel.EMAIL,
        body: 'Ваш наряд {{orderNumber}} готовий',
        subject: 'Наряд {{orderNumber}}',
      },
    ]);

    const cfg = await service.resolveConfig('org-1', 'br-1', 'WO_COMPLETED');
    expect(cfg).not.toBeNull();
    expect(cfg!.channels).toHaveLength(1);
    expect(cfg!.channels[0]).toMatchObject({
      channel: NotificationChannel.EMAIL,
      templateBody: 'Ваш наряд {{orderNumber}} готовий',
      templateSubject: 'Наряд {{orderNumber}}',
    });
    // Запит шаблонів вибирає subject (для EMAIL) — регрес-guard проти видалення select.subject.
    expect(templateFindMany.mock.calls[0][0].select).toMatchObject({ subject: true });
  });

  it('EMAIL-канал з шаблоном без subject → templateSubject=undefined (не крашить)', async () => {
    channelConfigFindMany.mockResolvedValue([
      {
        channel: NotificationChannel.EMAIL,
        provider: 'smtp',
        apiKey: 'smtp-json',
        senderName: null,
        externalTemplateId: null,
      },
    ]);
    templateFindMany.mockResolvedValue([
      { channel: NotificationChannel.EMAIL, body: 'Тіло', subject: null },
    ]);

    const cfg = await service.resolveConfig('org-1', 'br-1', 'WO_COMPLETED');
    expect(cfg!.channels[0].templateSubject).toBeUndefined();
    expect(cfg!.channels[0].templateBody).toBe('Тіло');
  });
});

/**
 * activateProvider — ексклюзивна активація провайдера для філії.
 * Інваріант: після активації рівно ОДИН провайдер має enabled-канали (усі канали цього
 * провайдера enabled=true, канали всіх інших enabled=false), атомарно через $transaction.
 *
 * Тести моделюють in-memory сховище notificationChannelConfig, щоб перевіряти РЕАЛЬНИЙ
 * кінцевий стан (exclusivity/atomicity), а не лише форму where-клозів. Плюс окремі
 * асерти tenant-scope: обидва updateMany мають нести orgId+branchId (cross-org leak —
 * найгірший сценарій).
 */
