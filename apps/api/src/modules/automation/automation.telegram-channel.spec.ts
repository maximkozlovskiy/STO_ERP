/**
 * Власний Telegram-бот як канал правил (docs/objects/automation.md, BR-AUT-011, 022, 041, 051):
 * бот бере участь у ланцюжку «як у філії» на місці, яке йому задав власник (рядок каналу
 * TELEGRAM_BOT із `priority`), а не завжди першим; не підписаний одержувач боту недоступний —
 * ланцюжок іде далі. Канали тут резолвить СПРАВЖНІЙ `NotificationsService.resolveChannels` над
 * таблицями в пам'яті (`branchConfigs`), а chat id — справжній `TelegramRecipientsService`.
 */
import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { ActionRun } from './automation-actions.service';
import { eventVars } from './automation-engine';
import { AutomationRulesService } from './automation-rules.service';
import {
  ACTOR,
  CP,
  MECH_1,
  MECH_2,
  ON_LEAVE,
  ORG,
  OTHER_ORG,
  automationHarness,
  clientMessage,
  fakeCtx,
  fakeEvent,
  fakeRule,
  type HarnessInit,
} from './automation.spec-fixture';

const TOKEN = '123456:telegram-test-token-aaaaaaaaaaaa';
const CHAT = '700100';

/** Рядок каналу філії; бот — без ключа (токен лише в налаштуваннях org). */
const cfg = (channel: string, priority: number, over: Record<string, unknown> = {}) => ({
  channel,
  priority,
  provider: channel === 'TELEGRAM_BOT' ? 'telegram-bot' : channel === 'EMAIL' ? 'smtp' : 'turbosms',
  apiKey: channel === 'TELEGRAM_BOT' ? null : 'key',
  ...over,
});

const sub = (over: Record<string, unknown>) => ({
  orgId: ORG,
  chatId: CHAT,
  active: true,
  deletedAt: null,
  subscribedAt: new Date('2026-10-01T10:00:00.000Z'),
  counterpartyId: null,
  employeeId: null,
  ...over,
});

const clientSub = sub({ counterpartyId: CP });
const noChannels = { actions: [clientMessage({ channels: undefined })] };

async function fire(rule: Record<string, unknown>, init: HarnessInit) {
  const h = automationHarness({ rules: [fakeRule(rule)], botToken: TOKEN, ...init });
  await h.engine.handle(fakeEvent());
  const chain = (h.enqueueChain.mock.calls[0]?.[2] ?? []) as {
    channel: string;
    recipient: string;
    provider: string;
  }[];
  return { h, chain, run: h.runs[0], logs: h.tables.notificationLog.rows };
}

const route = (chain: { channel: string; recipient: string }[]) =>
  chain.map(c => `${c.channel}:${c.recipient}`);

describe('Telegram-бот у ланцюжку правила «як у філії» (BR-AUT-011)', () => {
  // guards: BR-AUT-011
  it('бот стоїть там, де його поставив власник: між Viber і SMS — другим, а не першим', async () => {
    const { chain } = await fire(noChannels, {
      branchConfigs: [cfg('VIBER', 0), cfg('TELEGRAM_BOT', 1), cfg('SMS', 2)],
      subscriptions: [clientSub],
    });
    expect(route(chain)).toEqual([
      'VIBER:+380671112233',
      `TELEGRAM_BOT:${CHAT}`,
      'SMS:+380671112233',
    ]);
    expect(chain[1]).toMatchObject({ provider: 'telegram-bot' });
  });

  // guards: BR-AUT-011
  it('власник поставив бота першим — бот перший; підписаний клієнт отримує в чат підписки', async () => {
    const { chain, run } = await fire(noChannels, {
      branchConfigs: [cfg('SMS', 1), cfg('TELEGRAM_BOT', 0)],
      subscriptions: [clientSub],
    });
    expect(route(chain)).toEqual([`TELEGRAM_BOT:${CHAT}`, 'SMS:+380671112233']);
    expect(run?.actionResults).toEqual([
      expect.objectContaining({ status: 'DONE', channels: ['TELEGRAM_BOT', 'SMS'] }),
    ]);
  });

  // guards: BR-AUT-011, BR-AUT-041
  it('клієнт не підписаний (чи підписка вимкнена / чужої org) — бот пропускається, ланцюжок іде далі', async () => {
    const configs = [cfg('TELEGRAM_BOT', 0), cfg('SMS', 1)];
    const none = await fire(noChannels, { branchConfigs: configs });
    expect(route(none.chain)).toEqual(['SMS:+380671112233']);

    const inactive = await fire(noChannels, {
      branchConfigs: configs,
      subscriptions: [sub({ counterpartyId: CP, active: false })],
    });
    expect(route(inactive.chain)).toEqual(['SMS:+380671112233']);

    const foreign = await fire(noChannels, {
      branchConfigs: configs,
      subscriptions: [sub({ counterpartyId: CP, orgId: OTHER_ORG })],
    });
    expect(route(foreign.chain)).toEqual(['SMS:+380671112233']);
  });

  // guards: BR-AUT-011
  it('без рядка бота у філії правило «як у філії» бота не бере, навіть підписаному', async () => {
    const { chain } = await fire(noChannels, {
      branchConfigs: [cfg('VIBER', 0), cfg('SMS', 1)],
      subscriptions: [clientSub],
    });
    expect(route(chain)).toEqual(['VIBER:+380671112233', 'SMS:+380671112233']);
  });

  // guards: BR-AUT-011, BR-AUT-040
  it('бота не підключено в організації чи рядок вимкнено — рядок бота ігнорується', async () => {
    const off = await fire(noChannels, {
      botToken: null,
      branchConfigs: [cfg('TELEGRAM_BOT', 0), cfg('SMS', 1)],
      subscriptions: [clientSub],
    });
    expect(route(off.chain)).toEqual(['SMS:+380671112233']);

    const disabled = await fire(noChannels, {
      branchConfigs: [cfg('TELEGRAM_BOT', 0, { enabled: false }), cfg('SMS', 1)],
      subscriptions: [clientSub],
    });
    expect(route(disabled.chain)).toEqual(['SMS:+380671112233']);
  });

  // guards: BR-AUT-011
  it('філія з legacy SMS і лише рядком бота — legacy SMS іде після бота (решта клієнтів не губиться)', async () => {
    const subscribed = await fire(noChannels, {
      branchConfigs: [cfg('TELEGRAM_BOT', 0)],
      legacySms: true,
      subscriptions: [clientSub],
    });
    expect(route(subscribed.chain)).toEqual([`TELEGRAM_BOT:${CHAT}`, 'SMS:+380671112233']);

    const notSubscribed = await fire(noChannels, {
      branchConfigs: [cfg('TELEGRAM_BOT', 0)],
      legacySms: true,
    });
    expect(route(notSubscribed.chain)).toEqual(['SMS:+380671112233']);
  });

  // guards: BR-AUT-011, BR-AUT-041
  it('клієнт без телефону й email, але підписаний — повідомлення йде ботом', async () => {
    const ctx = fakeCtx({ client: { ...fakeCtx().client!, phone: null, email: null } });
    const { chain } = await fire(noChannels, {
      ctx,
      branchConfigs: [cfg('SMS', 0), cfg('TELEGRAM_BOT', 1)],
      subscriptions: [clientSub],
    });
    expect(route(chain)).toEqual([`TELEGRAM_BOT:${CHAT}`]);
  });
});

describe('Telegram-бот у явному переліку каналів правила (BR-AUT-011)', () => {
  const onlyBot = { actions: [clientMessage({ channels: ['TELEGRAM_BOT'] })] };

  // guards: BR-AUT-011
  it('бот підключено — явний перелік бере бота і без рядка каналу у філії', async () => {
    const { chain } = await fire(
      { actions: [clientMessage({ channels: ['SMS', 'TELEGRAM_BOT'] })] },
      { branchConfigs: [cfg('SMS', 0)], subscriptions: [clientSub] },
    );
    expect(route(chain)).toEqual(['SMS:+380671112233', `TELEGRAM_BOT:${CHAT}`]);
  });

  // guards: BR-AUT-011, BR-AUT-041
  it('лише бот, клієнт не підписаний — SKIPPED «немає контакту»; бота не підключено — «бот не підключено»', async () => {
    const notSubscribed = await fire(onlyBot, { branchConfigs: [cfg('SMS', 0)] });
    expect(notSubscribed.h.enqueueChain).not.toHaveBeenCalled();
    expect(notSubscribed.logs[0]).toMatchObject({ status: 'SKIPPED', skipReason: 'NO_CONTACT' });

    const notConnected = await fire(onlyBot, {
      botToken: null,
      branchConfigs: [cfg('SMS', 0)],
      subscriptions: [clientSub],
    });
    expect(notConnected.h.enqueueChain).not.toHaveBeenCalled();
    expect(notConnected.logs[0]).toMatchObject({
      status: 'SKIPPED',
      skipReason: 'TELEGRAM_BOT_NOT_CONNECTED',
    });
  });

  // guards: BR-AUT-011
  it('філія вимкнула бота своїм рядком — явний перелік його теж не бере', async () => {
    const { h, logs } = await fire(onlyBot, {
      branchConfigs: [cfg('TELEGRAM_BOT', 0, { enabled: false })],
      subscriptions: [clientSub],
    });
    expect(h.enqueueChain).not.toHaveBeenCalled();
    expect(logs[0]).toMatchObject({ status: 'SKIPPED', skipReason: 'NO_CHANNEL' });
  });
});

describe('Telegram-бот у зовнішньому сповіщенні працівнику (BR-AUT-022)', () => {
  const notify = (channels?: string[]) => ({
    actions: [
      {
        type: 'employee_notification',
        title: 'Наряд {{documentNumber}}',
        recipients: { employeeIds: [MECH_1, MECH_2] },
        inApp: false,
        external: { ...(channels && { channels }), template: { body: 'Наряд {{documentNumber}}' } },
      },
    ],
  });

  // guards: BR-AUT-022
  it('підписаний працівник — ботом, не підписаний — SMS за телефоном; chat id — одним запитом', async () => {
    const { h } = await fire(notify(['TELEGRAM_BOT', 'SMS']), {
      branchConfigs: [cfg('SMS', 0)],
      subscriptions: [sub({ employeeId: MECH_2, chatId: '700200' })],
    });
    const chains = h.enqueueChain.mock.calls.map(c => route(c[2] as never));
    expect(chains).toEqual([
      ['SMS:+380670000002'], // MECH_1: телефон є, підписки немає
      ['TELEGRAM_BOT:700200'], // MECH_2: телефону немає, підписаний
    ]);
    expect(h.tables.telegramSubscription.findMany).toHaveBeenCalledTimes(1);
  });

  // guards: BR-AUT-022, BR-AUT-011
  it('без переліку каналів — бот на місці з пріоритету філії серед дозволених працівнику', async () => {
    const { h } = await fire(notify(), {
      branchConfigs: [cfg('EMAIL', 0), cfg('TELEGRAM_BOT', 1), cfg('SMS', 2)],
      subscriptions: [sub({ employeeId: MECH_1, chatId: '700300' })],
    });
    expect(route(h.enqueueChain.mock.calls[0]![2] as never)).toEqual([
      'TELEGRAM_BOT:700300',
      'SMS:+380670000002',
    ]);
  });
});

describe('«Надіслати тест» на Telegram того, хто тестує (BR-AUT-051)', () => {
  // guards: BR-AUT-051
  it('тест іде в чат підписки того, хто тестує, а не клієнту документа', async () => {
    const h = automationHarness({
      botToken: TOKEN,
      branchConfigs: [cfg('TELEGRAM_BOT', 0), cfg('SMS', 1)],
      subscriptions: [clientSub],
    });
    const ctx = fakeCtx();
    const run: ActionRun = {
      orgId: ORG,
      rule: { id: 'rule-t', messageKind: 'SERVICE' },
      ctx,
      vars: eventVars(ctx, new Date()),
      actorId: ACTOR,
      occurredAt: new Date(),
      now: new Date(),
      test: { phone: null, email: null, telegramChatId: '700999' },
    };
    const res = await h.actions.clientMessage(
      0,
      clientMessage({ channels: undefined }) as never,
      run,
    );
    expect(res.status).toBe('DONE');
    expect(route(h.enqueueChain.mock.calls[0]![2] as never)).toEqual(['TELEGRAM_BOT:700999']);
  });

  // guards: BR-AUT-051
  it('«Надіслати тест»: у профілі ні телефону, ні email, але є підписка — тест іде ботом; без підписки — 400', async () => {
    const rule = fakeRule({ actions: [clientMessage({ channels: undefined })] });
    const h = automationHarness({
      rules: [rule],
      botToken: TOKEN,
      branchConfigs: [cfg('TELEGRAM_BOT', 0), cfg('SMS', 1)],
      subscriptions: [sub({ employeeId: MECH_2, chatId: '700777' })],
    });
    const svc = new AutomationRulesService(h.prisma, h.context, h.engine, h.telegram);
    const res = await svc.test(ORG, MECH_2, rule.id as string, 'doc-wo-1');
    expect(res.actionResults).toEqual([expect.objectContaining({ status: 'DONE' })]);
    expect(route(h.enqueueChain.mock.calls[0]![2] as never)).toEqual(['TELEGRAM_BOT:700777']);

    await expect(svc.test(ORG, ON_LEAVE, rule.id as string, 'doc-wo-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
