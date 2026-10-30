/**
 * Бажаний канал клієнта (docs/objects/automation.md, BR-AUT-011; рішення власника 2026-10-30
 * «Ставити першим»): `Counterparty.preferredChannel` у правилі «як у філії» йде першим, якщо він
 * доступний (налаштований у філії, є адреса одержувача; бот — лише підписаному), далі решта за
 * пріоритетом філії без повтору. Недоступний — ігнорується без «пропущено». Явний перелік каналів
 * правила — перевизначення власника: порядок не змінюється. Працівникам і «Надіслати тест» — ні.
 *
 * Канали резолвить СПРАВЖНІЙ `NotificationsService.resolveChannels` над таблицями в пам'яті, chat id
 * — справжній `TelegramRecipientsService`.
 */
import { describe, it, expect } from 'vitest';
import type { NotificationChannel } from '@prisma/client';
import type { ActionRun } from './automation-actions.service';
import { eventVars } from './automation-engine';
import {
  ACTOR,
  CP,
  MECH_1,
  ORG,
  automationHarness,
  clientMessage,
  fakeCtx,
  fakeEvent,
  fakeRule,
  type HarnessInit,
} from './automation.spec-fixture';

const TOKEN = '123456:telegram-test-token-aaaaaaaaaaaa';
const CHAT = '700100';
const PHONE = '+380671112233';
const EMAIL = 'ivan@example.com';

const cfg = (channel: string, priority: number) => ({
  channel,
  priority,
  provider: channel === 'TELEGRAM_BOT' ? 'telegram-bot' : channel === 'EMAIL' ? 'smtp' : 'turbosms',
  apiKey: channel === 'TELEGRAM_BOT' ? null : 'key',
});

const clientSub = {
  orgId: ORG,
  chatId: CHAT,
  active: true,
  deletedAt: null,
  subscribedAt: new Date('2026-10-01T10:00:00.000Z'),
  counterpartyId: CP,
  employeeId: null,
};

/** Контекст наряду, клієнт якого обрав бажаний канал (і, за потреби, без частини адрес). */
const ctxWith = (
  preferredChannel: NotificationChannel | null,
  over: { phone?: string | null; email?: string | null } = {},
) => fakeCtx({ client: { ...fakeCtx().client!, preferredChannel, ...over } });

const asBranch = { actions: [clientMessage({ channels: undefined })] };
const BRANCH_3 = [cfg('VIBER', 0), cfg('SMS', 1), cfg('EMAIL', 2)];

async function fire(rule: Record<string, unknown>, init: HarnessInit) {
  const h = automationHarness({ rules: [fakeRule(rule)], botToken: TOKEN, ...init });
  await h.engine.handle(fakeEvent());
  const calls = h.enqueueChain.mock.calls as unknown as unknown[][];
  const chain = (calls[0]?.[2] ?? []) as { channel: string; recipient: string }[];
  return { h, chain, logs: h.tables.notificationLog.rows };
}

const route = (chain: { channel: string; recipient: string }[]) =>
  chain.map(c => `${c.channel}:${c.recipient}`);

describe('Бажаний канал клієнта в правилі «як у філії» (BR-AUT-011)', () => {
  // guards: BR-AUT-011
  it('доступний бажаний канал іде першим, решта — за пріоритетом філії без повтору', async () => {
    const { chain } = await fire(asBranch, { ctx: ctxWith('EMAIL'), branchConfigs: BRANCH_3 });
    expect(route(chain)).toEqual([`EMAIL:${EMAIL}`, `VIBER:${PHONE}`, `SMS:${PHONE}`]);

    const middle = await fire(asBranch, { ctx: ctxWith('SMS'), branchConfigs: BRANCH_3 });
    expect(route(middle.chain)).toEqual([`SMS:${PHONE}`, `VIBER:${PHONE}`, `EMAIL:${EMAIL}`]);
  });

  // guards: BR-AUT-011
  it('бажаний — перший і за пріоритетом філії, чи не заданий — порядок філії без змін', async () => {
    const already = await fire(asBranch, { ctx: ctxWith('VIBER'), branchConfigs: BRANCH_3 });
    expect(route(already.chain)).toEqual([`VIBER:${PHONE}`, `SMS:${PHONE}`, `EMAIL:${EMAIL}`]);

    const none = await fire(asBranch, { ctx: ctxWith(null), branchConfigs: BRANCH_3 });
    expect(route(none.chain)).toEqual([`VIBER:${PHONE}`, `SMS:${PHONE}`, `EMAIL:${EMAIL}`]);
  });

  // guards: BR-AUT-011, BR-AUT-041
  it('бажаний Telegram-бот: підписаний — першим; не підписаний — порядок філії, без «пропущено»', async () => {
    const configs = [cfg('VIBER', 0), cfg('SMS', 1), cfg('TELEGRAM_BOT', 2)];
    const subscribed = await fire(asBranch, {
      ctx: ctxWith('TELEGRAM_BOT'),
      branchConfigs: configs,
      subscriptions: [clientSub],
    });
    expect(route(subscribed.chain)).toEqual([
      `TELEGRAM_BOT:${CHAT}`,
      `VIBER:${PHONE}`,
      `SMS:${PHONE}`,
    ]);

    const notSubscribed = await fire(asBranch, {
      ctx: ctxWith('TELEGRAM_BOT'),
      branchConfigs: configs,
    });
    expect(route(notSubscribed.chain)).toEqual([`VIBER:${PHONE}`, `SMS:${PHONE}`]);
    expect(notSubscribed.logs).toEqual([]);
  });

  // guards: BR-AUT-011
  it('бажаного каналу немає серед каналів філії чи немає адреси — ігнорується, без «пропущено»', async () => {
    // Бот підписаному клієнту, але у філії рядка бота немає — «як у філії» його не додає.
    const noBotRow = await fire(asBranch, {
      ctx: ctxWith('TELEGRAM_BOT'),
      branchConfigs: [cfg('VIBER', 0), cfg('SMS', 1)],
      subscriptions: [clientSub],
    });
    expect(route(noBotRow.chain)).toEqual([`VIBER:${PHONE}`, `SMS:${PHONE}`]);
    expect(noBotRow.logs).toEqual([]);

    // Email бажаний, але в клієнта email немає.
    const noEmail = await fire(asBranch, {
      ctx: ctxWith('EMAIL', { email: null }),
      branchConfigs: BRANCH_3,
    });
    expect(route(noEmail.chain)).toEqual([`VIBER:${PHONE}`, `SMS:${PHONE}`]);
    expect(noEmail.logs).toEqual([]);
  });
});

describe('Бажаний канал не діє поза «як у філії» (BR-AUT-011)', () => {
  // guards: BR-AUT-011
  it('явний перелік каналів правила — порядок правила, бажаний не переставляється й не додається', async () => {
    const reorder = await fire(
      { actions: [clientMessage({ channels: ['VIBER', 'SMS'] })] },
      { ctx: ctxWith('SMS'), branchConfigs: BRANCH_3 },
    );
    expect(route(reorder.chain)).toEqual([`VIBER:${PHONE}`, `SMS:${PHONE}`]);

    const outside = await fire(
      { actions: [clientMessage({ channels: ['VIBER', 'SMS'] })] },
      { ctx: ctxWith('EMAIL'), branchConfigs: BRANCH_3 },
    );
    expect(route(outside.chain)).toEqual([`VIBER:${PHONE}`, `SMS:${PHONE}`]);
  });

  // guards: BR-AUT-011, BR-AUT-022
  it('сповіщення працівнику «як у філії» — бажаний канал клієнта документа його не змінює', async () => {
    const { h } = await fire(
      {
        actions: [
          {
            type: 'employee_notification',
            title: 'Наряд {{documentNumber}}',
            recipients: { employeeIds: [MECH_1] },
            inApp: false,
            external: { template: { body: 'Наряд {{documentNumber}}' } },
          },
        ],
      },
      { ctx: ctxWith('SMS'), branchConfigs: [cfg('VIBER', 0), cfg('SMS', 1)] },
    );
    const calls = h.enqueueChain.mock.calls as unknown as unknown[][];
    expect(route(calls[0]![2] as never)).toEqual(['VIBER:+380670000002', 'SMS:+380670000002']);
  });

  // guards: BR-AUT-011, BR-AUT-051
  it('«Надіслати тест» — тому, хто тестує, за порядком філії: бажаний канал клієнта не діє', async () => {
    const h = automationHarness({ botToken: TOKEN, branchConfigs: BRANCH_3 });
    const ctx = ctxWith('EMAIL');
    const run: ActionRun = {
      orgId: ORG,
      rule: { id: 'rule-t', messageKind: 'SERVICE' },
      ctx,
      vars: eventVars(ctx, new Date()),
      actorId: ACTOR,
      occurredAt: new Date(),
      now: new Date(),
      test: { phone: '+380509998877', email: 'tester@example.com', telegramChatId: null },
    };
    await h.actions.clientMessage(0, clientMessage({ channels: undefined }) as never, run);
    const calls = h.enqueueChain.mock.calls as unknown as unknown[][];
    expect(route(calls[0]![2] as never)).toEqual([
      'VIBER:+380509998877',
      'SMS:+380509998877',
      'EMAIL:tester@example.com',
    ]);
  });
});
