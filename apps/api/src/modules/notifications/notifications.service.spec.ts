import { vi, describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
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
      config,
      { phone: '380671112233', clientName: 'Іван' },
      'br-1',
      'FOLLOWUP_REMINDER',
    );

    expect(queueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = queueAdd.mock.calls[0];
    expect(name).toBe('send-sms');
    expect(data.chainIndex).toBe(0);
    expect(data.chain).toHaveLength(2);
    expect(data.chain[0].message).toBe('Вітаємо, Іван!');
    expect(data.chain[0].recipient).toBe('380671112233'); // recipient обрано per-channel
    expect(data.chain[1].message).toBe('SMS Іван');
    // BullMQ: retry + removeOnFail (секрет apiKey у job.data не осідає назавжди)
    expect(opts.attempts).toBe(10);
    expect(opts.removeOnComplete).toBe(true);
    expect(opts.removeOnFail).toBe(200);
  });

  it('порожній config.channels → job НЕ ставиться (нема сенсу)', async () => {
    await service.sendWithConfig(
      'org-1',
      { channels: [] },
      { phone: '380671112233' },
      'br-1',
      'X' as never,
    );
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('невідома змінна шаблону → порожній рядок (не "undefined")', async () => {
    await service.sendWithConfig(
      'org-1',
      { channels: [{ ...config.channels[0], templateBody: 'X {{missing}} Y' }] },
      { phone: '380671112233' },
      'br-1',
      'FOLLOWUP_REMINDER',
    );
    expect(queueAdd.mock.calls[0][1].chain[0].message).toBe('X  Y');
  });

  it('EMAIL-канал без vars.email → канал пропускається (нема адресата)', async () => {
    await service.sendWithConfig(
      'org-1',
      {
        channels: [{ ...config.channels[0], channel: NotificationChannel.EMAIL, provider: 'smtp' }],
      },
      { phone: '380671112233' }, // є телефон, але немає email
      'br-1',
      'FOLLOWUP_REMINDER',
    );
    expect(queueAdd).not.toHaveBeenCalled(); // EMAIL без email → chain порожній
  });

  it('EMAIL-канал з vars.email → recipient = email, subject відрендерено', async () => {
    await service.sendWithConfig(
      'org-1',
      {
        channels: [
          {
            channel: NotificationChannel.EMAIL,
            provider: 'smtp',
            apiKey: 'k',
            senderName: 'STO',
            templateBody: 'Тіло {{clientName}}',
            templateSubject: 'Тема {{clientName}}',
          },
        ],
      },
      { email: 'a@b.com', clientName: 'Іван' },
      'br-1',
      'FOLLOWUP_REMINDER',
    );
    const step = queueAdd.mock.calls[0][1].chain[0];
    expect(step.recipient).toBe('a@b.com');
    expect(step.message).toBe('Тіло Іван');
    expect(step.subject).toBe('Тема Іван');
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
