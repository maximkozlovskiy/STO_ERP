/**
 * Надсилання власним Telegram-ботом (docs/objects/automation.md, BR-AUT-022, 040, 041): клієнт
 * Bot API (адреса з конфігу, токен не тече в помилки), провайдер `telegram-bot` і крок черги `sms`:
 * токен — з налаштувань організації, «бота заблоковано» (403) — підписку вимкнено, ланцюжок далі,
 * без повторів. HTTP — підмінений `fetch`, БД — таблиці в пам'яті.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import type { PrismaService } from '../../prisma/prisma.service';
import { memoryTable } from '../cash/cash.spec-fixture';
import type { DeadLetterService } from '../dead-letter/dead-letter.service';
import type { NotificationProviderRegistry } from './providers/provider-registry';
import {
  TELEGRAM_API_DEFAULT_URL,
  TelegramApiClient,
  TelegramApiError,
  TelegramNetworkError,
} from './providers/telegram-api.client';
import { TelegramBotProvider } from './providers/telegram-bot.provider';
import { SmsProcessor } from './sms.processor';
import { TelegramRecipientsService } from './telegram-recipients.service';

const TOKEN = '123456:telegram-test-token-aaaaaaaaaaaa';
const ORG = 'org-a';

type FetchArgs = [string, { body: string }];
const fetchMock = vi.fn();

function reply(status: number, body: unknown) {
  return Promise.resolve({ status, ok: status < 300, json: () => Promise.resolve(body) });
}

const client = (url?: string) =>
  new TelegramApiClient({ get: vi.fn().mockReturnValue(url) } as unknown as ConfigService);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('TelegramApiClient', () => {
  // guards: BR-AUT-040
  it('адреса Bot API — з конфігу (фейк для тестів), типово api.telegram.org; токен — у шляху', async () => {
    fetchMock.mockReturnValue(reply(200, { ok: true, result: { id: 1, is_bot: true } }));
    await client('http://127.0.0.1:9999/').getMe(TOKEN);
    await client(undefined).getMe(TOKEN);
    const urls = fetchMock.mock.calls.map(c => (c as FetchArgs)[0]);
    expect(urls).toEqual([
      `http://127.0.0.1:9999/bot${TOKEN}/getMe`,
      `${TELEGRAM_API_DEFAULT_URL}/bot${TOKEN}/getMe`,
    ]);
  });

  // guards: BR-AUT-040
  it('ok:false — TelegramApiError з кодом; мережа — TelegramNetworkError; токен у текст не потрапляє', async () => {
    fetchMock.mockReturnValueOnce(
      reply(401, { ok: false, error_code: 401, description: `Unauthorized ${TOKEN}` }),
    );
    const apiErr = await client()
      .getMe(TOKEN)
      .catch((e: unknown) => e);
    expect(apiErr).toBeInstanceOf(TelegramApiError);
    expect((apiErr as TelegramApiError).errorCode).toBe(401);
    expect((apiErr as Error).message).not.toContain(TOKEN);

    fetchMock.mockRejectedValueOnce(new Error(`connect ECONNREFUSED /bot${TOKEN}/getMe`));
    const netErr = await client()
      .getMe(TOKEN)
      .catch((e: unknown) => e);
    expect(netErr).toBeInstanceOf(TelegramNetworkError);
    expect((netErr as Error).message).not.toContain(TOKEN);
  });
});

describe('TelegramBotProvider', () => {
  const provider = () => new TelegramBotProvider(client());
  const params = {
    channel: 'TELEGRAM_BOT' as const,
    recipient: '700100',
    message: 'Ваше авто в роботі',
    creds: { apiKey: TOKEN },
  };

  // guards: BR-AUT-022
  it('sendMessage у chat id підписки; прийнято — id повідомлення', async () => {
    fetchMock.mockReturnValue(reply(200, { ok: true, result: { message_id: 42, chat: {} } }));
    await expect(provider().send(params)).resolves.toEqual({
      accepted: true,
      providerMessageId: '42',
    });
    const [url, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(url).toMatch(/\/sendMessage$/);
    expect(JSON.parse(init.body)).toEqual({ chat_id: '700100', text: 'Ваше авто в роботі' });
  });

  // guards: BR-AUT-041
  it('403 «bot was blocked» — остаточна відмова з позначкою «заблоковано»; 429 і мережа — тимчасові', async () => {
    fetchMock.mockReturnValueOnce(
      reply(403, {
        ok: false,
        error_code: 403,
        description: 'Forbidden: bot was blocked by the user',
      }),
    );
    expect(await provider().send(params)).toMatchObject({
      accepted: false,
      permanent: true,
      recipientBlocked: true,
    });
    fetchMock.mockReturnValueOnce(
      reply(429, { ok: false, error_code: 429, description: 'Too Many' }),
    );
    expect(await provider().send(params)).toMatchObject({ accepted: false, permanent: false });
    fetchMock.mockRejectedValueOnce(new Error('fetch failed'));
    const offline = await provider().send(params);
    expect(offline.accepted).toBe(false);
    expect(offline.permanent).toBeFalsy();
  });
});

describe('Крок черги `sms` каналом TELEGRAM_BOT', () => {
  function setup(opts: { token?: string | null; send: ReturnType<typeof vi.fn> }) {
    const subs = memoryTable([
      {
        id: 's1',
        orgId: ORG,
        chatId: '700100',
        counterpartyId: 'cp-1',
        active: true,
        deletedAt: null,
      },
      { id: 's2', orgId: ORG, chatId: '700100', employeeId: 'e-1', active: true, deletedAt: null },
      {
        id: 's3',
        orgId: 'org-b',
        chatId: '700100',
        counterpartyId: 'cp-9',
        active: true,
        deletedAt: null,
      },
    ]);
    const logs = memoryTable([]);
    const channelConfig = memoryTable([]);
    const prisma = {
      telegramSubscription: subs,
      notificationLog: logs,
      notificationChannelConfig: channelConfig,
      branchSettings: memoryTable([]),
      organisationSettings: memoryTable([{ orgId: ORG, telegramBotToken: opts.token ?? null }]),
    } as unknown as PrismaService;
    const impl = { code: 'telegram-bot', orgCredentials: true, send: opts.send };
    const registry = {
      get: vi.fn().mockReturnValue(impl),
    } as unknown as NotificationProviderRegistry;
    const queueAdd = vi.fn().mockResolvedValue({});
    const processor = new SmsProcessor(
      registry,
      prisma,
      { add: queueAdd } as unknown as Queue,
      { capture: vi.fn() } as unknown as DeadLetterService,
      new TelegramRecipientsService(prisma),
    );
    return { processor, subs, logs, queueAdd, channelConfig };
  }

  const step = (channel: string, recipient: string) => ({
    channel,
    provider: channel === 'TELEGRAM_BOT' ? 'telegram-bot' : 'turbosms',
    senderName: '',
    message: 'Ваше авто в роботі',
    recipient,
  });
  const job = (chain: ReturnType<typeof step>[]) =>
    ({
      data: { orgId: ORG, branchId: 'br-1', meta: { ruleId: 'r-1' }, chain, chainIndex: 0 },
      attemptsMade: 0,
    }) as unknown as Job;

  // guards: BR-AUT-040
  it('токен — з налаштувань організації, а не з рядка каналу філії', async () => {
    const send = vi.fn().mockResolvedValue({ accepted: true, providerMessageId: '1' });
    const { processor, channelConfig, logs } = setup({ token: TOKEN, send });
    await processor.process(job([step('TELEGRAM_BOT', '700100')]));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ creds: { apiKey: TOKEN, senderName: '' } }),
    );
    expect(channelConfig.findFirst).not.toHaveBeenCalled();
    expect(logs.rows[0]).toMatchObject({
      status: 'SENT',
      channel: 'TELEGRAM_BOT',
      recipient: '700100',
    });
  });

  // guards: BR-AUT-040
  it('бота відключено, поки повідомлення чекало в черзі — FAILED у журналі, без надсилання', async () => {
    const send = vi.fn();
    const { processor, logs } = setup({ token: null, send });
    await processor.process(job([step('TELEGRAM_BOT', '700100')]));
    expect(send).not.toHaveBeenCalled();
    expect(logs.rows[0]).toMatchObject({ status: 'FAILED' });
  });

  // guards: BR-AUT-041
  it('бота заблоковано — підписки цього чату в org вимкнено, журнал REJECTED, далі SMS; чужа org не зачеплена', async () => {
    const send = vi.fn().mockResolvedValue({
      accepted: false,
      permanent: true,
      recipientBlocked: true,
      error: 'Telegram 403: Forbidden: bot was blocked by the user',
    });
    const { processor, subs, logs, queueAdd } = setup({ token: TOKEN, send });
    await processor.process(job([step('TELEGRAM_BOT', '700100'), step('SMS', '+380671112233')]));
    expect(subs.rows.map(s => [s.id, s.active])).toEqual([
      ['s1', false],
      ['s2', false],
      ['s3', true],
    ]);
    expect(subs.rows[0]!.unsubscribedAt).toBeInstanceOf(Date);
    expect(logs.rows[0]).toMatchObject({ status: 'REJECTED', channel: 'TELEGRAM_BOT' });
    expect(String(logs.rows[0]!.error)).toContain('підписку на бота вимкнено');
    expect(queueAdd).toHaveBeenCalledWith(
      'send-sms',
      expect.objectContaining({ chainIndex: 1 }),
      expect.anything(),
    );
  });

  // guards: BR-AUT-041, BR-AUT-015
  it('остаточна відмова на останньому каналі — без повтору черги; тимчасова — повтор (throw)', async () => {
    const blocked = setup({
      token: TOKEN,
      send: vi.fn().mockResolvedValue({ accepted: false, permanent: true, recipientBlocked: true }),
    });
    await expect(
      blocked.processor.process(job([step('TELEGRAM_BOT', '700100')])),
    ).resolves.toBeUndefined();

    const offline = setup({
      token: TOKEN,
      send: vi.fn().mockResolvedValue({ accepted: false, error: 'Telegram недоступний' }),
    });
    await expect(offline.processor.process(job([step('TELEGRAM_BOT', '700100')]))).rejects.toThrow(
      'Telegram недоступний',
    );
    expect(offline.subs.rows.every(s => s.active)).toBe(true);
  });
});
