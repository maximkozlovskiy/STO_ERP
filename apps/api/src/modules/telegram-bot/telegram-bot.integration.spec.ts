import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createPgAdapter } from '../../prisma/pg-adapter';
import { withTenantGuard } from '../../prisma/tenant-guard.extension';
import type { PrismaService } from '../../prisma/prisma.service';
import { runWithTenant } from '../../common/tenant/tenant-context';
import { handleDbUnavailable, testDatabaseUrl } from '../../common/testing/require-db';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type {
  TelegramApiClient,
  TelegramUpdate,
} from '../notifications/providers/telegram-api.client';
import { TelegramRecipientsService } from '../notifications/telegram-recipients.service';
import type { TelegramBotScheduler } from './telegram-bot.scheduler';
import { TelegramBotService } from './telegram-bot.service';

/**
 * Підписка на власний Telegram-бот на ЖИВІЙ БД (docs/objects/automation.md, BR-AUT-041): код →
 * `/start` → рядок `telegram_subscriptions` з chat id, код використано, offset у налаштуваннях
 * (BIGINT); повтор того самого оновлення — без дубля; `/stop` — підписку вимкнено. Через
 * tenant-guard, як у prisma.service. Bot API — фейк.
 *
 * Дані — власна організація (випадковий uuid, назва з префіксом `000 TST`); прибирання в
 * `afterAll` за цим orgId. Без БД — SKIP (у CI з REQUIRE_DB=1 — падіння).
 */
const ORG = randomUUID();
const CHAT = 880011;

let raw: PrismaClient;
let guarded: PrismaClient;
let dbAvailable = false;
let counterpartyId = '';

const getUpdates = vi.fn();
const enqueueChain = vi.fn().mockResolvedValue(undefined);

function service(): TelegramBotService {
  const prisma = guarded as unknown as PrismaService;
  return new TelegramBotService(
    prisma,
    { getUpdates } as unknown as TelegramApiClient,
    new TelegramRecipientsService(prisma),
    { enqueueChain } as unknown as NotificationsService,
    { start: vi.fn(), stop: vi.fn() } as unknown as TelegramBotScheduler,
    { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService,
  );
}

const update = (id: number, text: string): TelegramUpdate => ({
  update_id: id,
  message: { message_id: id, chat: { id: CHAT, type: 'private' }, text },
});

const inOrg = <T>(fn: () => Promise<T>) => runWithTenant({ orgId: ORG }, fn);

beforeAll(async () => {
  raw = new PrismaClient({ adapter: createPgAdapter(testDatabaseUrl()) });
  try {
    await raw.$connect();
    await raw.$queryRaw`SELECT "telegramBotUpdateOffset" FROM organisation_settings LIMIT 1`;
    guarded = withTenantGuard(raw) as PrismaClient;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    handleDbUnavailable('підключення або колонка telegramBotUpdateOffset недоступні');
    return;
  }
  await raw.organisation.create({ data: { id: ORG, orgId: ORG, name: '000 TST telegram-бот' } });
  await raw.organisationSettings.create({
    data: {
      orgId: ORG,
      telegramBotToken: '123456:integration-test-token-aaaaaaaaa',
      telegramBotUsername: 'sto_integration_bot',
    },
  });
  const cp = await raw.counterparty.create({
    data: { orgId: ORG, type: 'CLIENT', firstName: 'Тест', lastName: '000 TST' },
  });
  counterpartyId = cp.id;
}, 30_000);

afterAll(async () => {
  if (raw && dbAvailable) {
    const where = { where: { orgId: ORG } };
    await raw.telegramSubscription.deleteMany(where).catch(() => undefined);
    await raw.telegramLinkCode.deleteMany(where).catch(() => undefined);
    await raw.counterparty.deleteMany(where).catch(() => undefined);
    await raw.organisationSettings.deleteMany(where).catch(() => undefined);
    await raw.organisation.deleteMany({ where: { id: ORG } }).catch(() => undefined);
  }
  await raw?.$disconnect().catch(() => undefined);
});

describe('Telegram-бот — підписка на живій БД', () => {
  // guards: BR-AUT-041
  it('код → /start → підписка з chat id, код використано, offset збережено; повтор — без дубля; /stop', async () => {
    if (!dbAvailable) return;
    const bot = service();
    const link = await inOrg(() =>
      bot.createLink(ORG, { kind: 'counterparty', id: counterpartyId }, ORG),
    );
    expect(link.url).toBe(`https://t.me/sto_integration_bot?start=${link.code}`);

    const start = update(5001, `/start ${link.code}`);
    getUpdates.mockResolvedValueOnce([start]).mockResolvedValueOnce([start]);
    await inOrg(() => bot.poll(ORG));
    // Рестарт до запису offset: те саме оновлення ще раз — ідемпотентно.
    await raw.organisationSettings.update({
      where: { orgId: ORG },
      data: { telegramBotUpdateOffset: null },
    });
    await inOrg(() => bot.poll(ORG));

    const subs = await raw.telegramSubscription.findMany({ where: { orgId: ORG } });
    expect(subs).toEqual([
      expect.objectContaining({ counterpartyId, chatId: String(CHAT), active: true }),
    ]);
    const code = await raw.telegramLinkCode.findFirst({ where: { orgId: ORG, code: link.code } });
    expect(code?.usedAt).toBeInstanceOf(Date);
    const settings = await raw.organisationSettings.findUnique({ where: { orgId: ORG } });
    expect(settings?.telegramBotUpdateOffset).toBe(BigInt(5002));
    expect(
      await inOrg(() =>
        new TelegramRecipientsService(guarded as unknown as PrismaService).chatIds(
          ORG,
          'counterparty',
          [counterpartyId],
        ),
      ),
    ).toEqual(new Map([[counterpartyId, String(CHAT)]]));

    getUpdates.mockResolvedValueOnce([update(5002, '/stop')]);
    await inOrg(() => bot.poll(ORG));
    const after = await raw.telegramSubscription.findFirst({ where: { orgId: ORG } });
    expect(after).toMatchObject({ active: false });
    expect(after?.unsubscribedAt).toBeInstanceOf(Date);
    expect(getUpdates).toHaveBeenLastCalledWith(expect.any(String), 5002);
  });
});
