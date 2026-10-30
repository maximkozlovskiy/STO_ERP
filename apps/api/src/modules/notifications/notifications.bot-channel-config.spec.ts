/**
 * Рядок каналу TELEGRAM_BOT у налаштуваннях каналів філії (docs/objects/automation.md, BR-AUT-011,
 * 040): місце бота в пріоритеті задає власник, облікових даних у рядку немає (токен — у
 * налаштуваннях організації), ексклюзивна активація іншого провайдера бота не вимикає.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import type { PrismaService } from '../../prisma/prisma.service';
import { memoryTable } from '../cash/cash.spec-fixture';
import { NotificationsService } from './notifications.service';
import type { NotificationProviderRegistry } from './providers/provider-registry';
import { TelegramRecipientsService } from './telegram-recipients.service';

const ORG = 'org-a';
const BRANCH = 'b0000000-0000-4000-8000-000000000001';

function setup(token: string | null, rows: Record<string, unknown>[] = []) {
  const providers: Record<string, Record<string, unknown>> = {
    turbosms: { code: 'turbosms', channels: ['SMS', 'VIBER'] },
    'telegram-bot': { code: 'telegram-bot', channels: ['TELEGRAM_BOT'], orgCredentials: true },
  };
  const registry = {
    get: (code: string) => providers[code] ?? null,
  } as unknown as NotificationProviderRegistry;
  const configs = memoryTable(
    rows.map(r => ({ orgId: ORG, branchId: BRANCH, deletedAt: null, enabled: true, ...r })),
    () => ({ deletedAt: null }),
  );
  const prisma = {
    notificationChannelConfig: configs,
    garageBranch: memoryTable([{ id: BRANCH, orgId: ORG, deletedAt: null }]),
    organisationSettings: memoryTable([{ orgId: ORG, telegramBotToken: token }]),
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  } as unknown as PrismaService;
  const service = new NotificationsService(
    prisma,
    registry,
    { add: vi.fn() } as unknown as Queue,
    new TelegramRecipientsService(prisma),
  );
  return { service, configs };
}

describe('Рядок каналу Telegram-бота у філії (BR-AUT-011, 040)', () => {
  // guards: BR-AUT-040
  it('рядок бота з пріоритетом власника — без ключа, навіть якщо ключ надіслали', async () => {
    const { service, configs } = setup('123:token');
    await service.upsertBranchChannel(ORG, BRANCH, {
      channel: 'TELEGRAM_BOT',
      provider: 'telegram-bot',
      priority: 1,
      apiKey: 'не-має-зберегтися',
    });
    expect(configs.rows[0]).toMatchObject({ channel: 'TELEGRAM_BOT', priority: 1 });
    expect(configs.rows[0]!.apiKey).toBeUndefined();
  });

  // guards: BR-AUT-040
  it('«ключ є» для рядка бота = бота підключено в організації; ключ не віддається', async () => {
    const row = {
      id: 'c1',
      channel: 'TELEGRAM_BOT',
      provider: 'telegram-bot',
      priority: 0,
      apiKey: null,
    };
    const on = await setup('123:token', [row]).service.getBranchChannels(ORG, BRANCH);
    expect(on[0]).toMatchObject({ channel: 'TELEGRAM_BOT', hasApiKey: true });
    expect(on[0]).not.toHaveProperty('apiKey');
    const off = await setup(null, [row]).service.getBranchChannels(ORG, BRANCH);
    expect(off[0]).toMatchObject({ hasApiKey: false });
  });

  // guards: BR-AUT-011
  it('активація іншого провайдера бота не вимикає; «активація» бота інших не вимикає', async () => {
    const rows = [
      { id: 's', channel: 'SMS', provider: 'turbosms', enabled: false, apiKey: 'k' },
      { id: 'b', channel: 'TELEGRAM_BOT', provider: 'telegram-bot', enabled: true },
      { id: 'v', channel: 'VIBER', provider: 'esputnik', enabled: true, apiKey: 'k' },
    ];
    const a = setup('123:token', rows);
    await a.service.activateProvider(ORG, BRANCH, 'turbosms');
    expect(a.configs.rows.map(r => [r.id, r.enabled])).toEqual([
      ['s', true],
      ['b', true],
      ['v', false],
    ]);

    const b = setup(
      '123:token',
      rows.map(r => ({ ...r, enabled: r.id === 's' })),
    );
    await b.service.activateProvider(ORG, BRANCH, 'telegram-bot');
    expect(b.configs.rows.map(r => [r.id, r.enabled])).toEqual([
      ['s', true],
      ['b', true],
      ['v', false],
    ]);
  });
});
