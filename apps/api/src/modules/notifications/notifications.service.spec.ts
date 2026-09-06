import { vi, describe, it, expect, beforeEach } from 'vitest';
import { NotificationChannel } from '@prisma/client';
import { Queue } from 'bullmq';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationProviderRegistry } from './providers/provider-registry';

/**
 * resolveConfig — fallback-ланцюг з NotificationChannelConfig (priority ASC) + per-канал
 * шаблон; legacy read-fallback на BranchSettings.sms* коли конфіг-рядків немає.
 * sendWithConfig — рендер per-канал + постановка одного job (chainIndex=0) з BullMQ-опціями.
 *
 * Ці тести фіксують edge-cases fallback-движка (Phase 2): порожній ланцюг, apiKey NULL,
 * відсутність шаблону, batch-abort (null), backward-compat legacy, PII-безпечність.
 */
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

describe('NotificationsService.sendWithConfig', () => {
  const queueAdd = vi.fn().mockResolvedValue({});
  const queue = { add: queueAdd } as unknown as Queue;
  const prisma = {} as unknown as PrismaService;
  const registry = { get: vi.fn(), list: vi.fn() } as unknown as NotificationProviderRegistry;

  let service: NotificationsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new NotificationsService(prisma, registry, queue);
  });

  const config = {
    channels: [
      {
        channel: NotificationChannel.VIBER,
        provider: 'turbosms',
        apiKey: 'k1',
        senderName: 'STO',
        templateBody: 'Вітаємо, {{clientName}}!',
      },
      {
        channel: NotificationChannel.SMS,
        provider: 'turbosms',
        apiKey: 'k2',
        senderName: 'STO',
        templateBody: 'SMS {{clientName}}',
      },
    ],
  };

  it('рендерить шаблон per-канал і ставить ОДИН job з chainIndex=0', async () => {
    await service.sendWithConfig(
      'org-1',
      '380671112233',
      config,
      { clientName: 'Іван' },
      'br-1',
      'FOLLOWUP_REMINDER',
    );

    expect(queueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queueAdd.mock.calls[0];
    expect(name).toBe('send-sms');
    expect(data.chainIndex).toBe(0);
    expect(data.chain).toHaveLength(2);
    expect(data.chain[0].message).toBe('Вітаємо, Іван!');
    expect(data.chain[1].message).toBe('SMS Іван');
    // BullMQ: retry + removeOnFail (секрет apiKey у job.data не осідає назавжди)
    expect(opts.attempts).toBe(10);
    expect(opts.removeOnComplete).toBe(true);
    expect(opts.removeOnFail).toBe(200);
  });

  it('порожній config.channels → job НЕ ставиться (нема сенсу)', async () => {
    await service.sendWithConfig(
      'org-1',
      '380671112233',
      { channels: [] },
      {},
      'br-1',
      'X' as never,
    );
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('невідома змінна шаблону → порожній рядок (не "undefined")', async () => {
    await service.sendWithConfig(
      'org-1',
      '380671112233',
      { channels: [{ ...config.channels[0], templateBody: 'X {{missing}} Y' }] },
      {},
      'br-1',
      'FOLLOWUP_REMINDER',
    );
    expect(queueAdd.mock.calls[0][1].chain[0].message).toBe('X  Y');
  });
});
