import { vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service';
import { memoryTable } from '../cash/cash.spec-fixture';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type {
  TelegramApiClient,
  TelegramUpdate,
} from '../notifications/providers/telegram-api.client';
import { TelegramRecipientsService } from '../notifications/telegram-recipients.service';
import type { TelegramBotScheduler } from './telegram-bot.scheduler';
import { TelegramBotService } from './telegram-bot.service';

// Сервіс бота над таблицями в пам'яті: `where` справді обчислюється (memoryTable), тож зниклий
// `orgId`, `usedAt: null` чи `active: true` у фільтрі ламає тест. Bot API — фейк.
// Factory, не const: `isolate: false` без `clearMocks` — спільний стан протікав би між файлами.

type Row = Record<string, unknown>;

export const ORG = 'org-a';
export const OTHER_ORG = 'org-b';
export const CP = 'c0000000-0000-4000-8000-000000000001';
export const FOREIGN_CP = 'c0000000-0000-4000-8000-000000000002';
export const EMP = 'e0000000-0000-4000-8000-000000000001';
export const FIRED_EMP = 'e0000000-0000-4000-8000-000000000002';
export const ADMIN = 'e0000000-0000-4000-8000-000000000003';
export const TOKEN = '123456:telegram-test-token-aaaaaaaaaaaa';
export const CHAT = 700100;

export interface BotHarnessInit {
  token?: string | null;
  offset?: bigint | null;
  codes?: Row[];
  subscriptions?: Row[];
}

export function botHarness(init: BotHarnessInit = {}) {
  const tables = {
    organisationSettings: memoryTable([
      {
        orgId: ORG,
        language: 'uk',
        telegramBotToken: init.token === undefined ? TOKEN : init.token,
        telegramBotUsername: init.token === null ? null : 'sto_test_bot',
        telegramBotUpdateOffset: init.offset ?? null,
      },
      { orgId: OTHER_ORG, language: 'uk', telegramBotToken: 'other', telegramBotUsername: 'other' },
    ]),
    organisation: memoryTable([
      { id: ORG, orgId: ORG, name: 'СТО Тест', deletedAt: null },
      { id: OTHER_ORG, orgId: OTHER_ORG, name: 'Чуже СТО', deletedAt: null },
    ]),
    counterparty: memoryTable([
      { id: CP, orgId: ORG, deletedAt: null },
      { id: FOREIGN_CP, orgId: OTHER_ORG, deletedAt: null },
    ]),
    employee: memoryTable([
      { id: EMP, orgId: ORG, status: 'ACTIVE', deletedAt: null },
      { id: FIRED_EMP, orgId: ORG, status: 'FIRED', deletedAt: null },
      { id: ADMIN, orgId: ORG, status: 'ACTIVE', deletedAt: null },
    ]),
    telegramLinkCode: memoryTable(init.codes ?? [], () => ({ usedAt: null, deletedAt: null })),
    telegramSubscription: memoryTable(init.subscriptions ?? [], () => ({
      active: true,
      deletedAt: null,
      unsubscribedAt: null,
      counterpartyId: null,
      employeeId: null,
    })),
  };
  const prisma = {
    ...tables,
    $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
  } as unknown as PrismaService & typeof tables;

  const api = {
    getMe: vi.fn().mockResolvedValue({ id: 123456, is_bot: true, username: 'sto_test_bot' }),
    getUpdates: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn(),
  };
  const enqueueChain = vi.fn().mockResolvedValue(undefined);
  const scheduler = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new TelegramBotService(
    prisma,
    api as unknown as TelegramApiClient,
    new TelegramRecipientsService(prisma),
    { enqueueChain } as unknown as NotificationsService,
    scheduler as unknown as TelegramBotScheduler,
    audit as unknown as AuditService,
  );
  /** Відповіді бота: chat id → текст (крок ланцюжка черги `sms`). */
  const replies = () =>
    enqueueChain.mock.calls.map(c => {
      const [step] = c[2] as [{ recipient: string; message: string; channel: string }];
      return { chat: step.recipient, text: step.message, channel: step.channel };
    });
  return { prisma, tables, api, service, enqueueChain, scheduler, audit, replies };
}

let seq = 0;

/** Оновлення getUpdates: текст в особистому чаті. */
export function textUpdate(text: string, chat = CHAT, type = 'private'): TelegramUpdate {
  seq += 1;
  return {
    update_id: 1000 + seq,
    message: { message_id: seq, chat: { id: chat, type }, text },
  };
}

export function linkCode(over: Row = {}): Row {
  return {
    id: `code-${(seq += 1)}`,
    orgId: ORG,
    code: `CODE${seq}`,
    counterpartyId: CP,
    employeeId: null,
    expiresAt: new Date(Date.now() + 86_400_000),
    usedAt: null,
    deletedAt: null,
    ...over,
  };
}
