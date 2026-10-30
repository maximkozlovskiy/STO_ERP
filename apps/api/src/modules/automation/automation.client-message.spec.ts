/**
 * Дія «повідомлення клієнту» (docs/objects/automation.md, BR-AUT-010…015, 050, 051): одержувач,
 * згода, канали правила, тихі години, черга з повторами, журнал «пропущено» з причиною.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Queue } from 'bullmq';
import { AUTOMATION_DEFAULT_RULES, defaultRuleActions } from '@sto/shared';
import { NotificationsService } from '../notifications/notifications.service';
import type { TelegramRecipientsService } from '../notifications/telegram-recipients.service';
import type { NotificationProviderRegistry } from '../notifications/providers/provider-registry';
import type { PrismaService } from '../../prisma/prisma.service';
import { memoryTable } from '../cash/cash.spec-fixture';
import type { ActionRun } from './automation-actions.service';
import { eventVars } from './automation-engine';
import {
  ACTOR,
  CP,
  automationHarness,
  clientMessage,
  fakeCtx,
  fakeEvent,
  fakeRule,
} from './automation.spec-fixture';
import type { DocumentContext } from './automation-context.service';

type Client = NonNullable<DocumentContext['client']>;
const client = (over: Partial<Client>): Client => ({ ...fakeCtx().client!, ...over });

async function fire(opts: {
  ctx?: DocumentContext;
  rule?: Record<string, unknown>;
  channels?: string[];
  quiet?: [string, string];
  occurredAt?: Date;
}) {
  const rule = fakeRule(opts.rule);
  const h = automationHarness({
    rules: [rule],
    ctx: opts.ctx ?? fakeCtx(),
    channels: opts.channels,
    quiet: opts.quiet,
  });
  await h.engine.handle(fakeEvent(opts.occurredAt ? { occurredAt: opts.occurredAt } : {}));
  return { h, rule, run: h.runs[0], logs: h.tables.notificationLog.rows };
}

describe('Дія «повідомлення клієнту»', () => {
  // guards: BR-AUT-010, BR-AUT-014, BR-AUT-016
  it('одержувач — клієнт документа; текст — шаблон правила з підставленими змінними', async () => {
    const { h, run } = await fire({});
    expect(run?.status).toBe('DONE');
    const [orgId, branchId, chain, opts] = h.enqueueChain.mock.calls[0]!;
    expect(orgId).toBe('org-a');
    expect(branchId).toBe(fakeCtx().messageBranchId);
    expect(chain).toEqual([
      expect.objectContaining({
        channel: 'VIBER',
        recipient: '+380671112233',
        message: 'Петренко Іван, авто Toyota Camry (AA1234BB): В роботі',
      }),
      expect.objectContaining({ channel: 'SMS', recipient: '+380671112233' }),
    ]);
    expect(opts).toMatchObject({
      meta: {
        ruleId: run?.ruleId,
        documentType: 'WORK_ORDER',
        documentId: 'doc-wo-1',
        // BR-AUT-016: подія правила — для перевірки доречності на мить відправки.
        eventKind: 'STATUS_CHANGED',
        counterpartyId: CP,
        isTest: false,
      },
    });
  });

  // Bug #998: «…Головна філія, тел. » — у організації немає телефону.
  // guards: BR-AUT-014
  it('типове правило: телефон організації порожній — без «, тел. »; є — з телефоном', async () => {
    const wo = AUTOMATION_DEFAULT_RULES.find(r => r.systemKey === 'WO_COMPLETED_CLIENT')!;
    const text = async (branchPhone: string) => {
      const { h } = await fire({
        rule: { actions: defaultRuleActions(wo) },
        ctx: fakeCtx({ vars: { ...fakeCtx().vars, branchName: 'Головна філія', branchPhone } }),
      });
      return (h.enqueueChain.mock.calls[0]![2] as { message: string }[])[0]!.message;
    };
    expect(await text('')).toMatch(/\(наряд НРД-7, сума 5 000,00 грн\)\. Головна філія$/);
    expect(await text('+380441234567')).toMatch(/Головна філія, тел\. \+380441234567$/);
  });

  // guards: BR-AUT-010, BR-AUT-050
  it('немає ні телефону, ні email — не надсилається; у журналі SKIPPED «немає контакту»', async () => {
    const { h, run, logs } = await fire({
      ctx: fakeCtx({ client: client({ phone: null, email: null }) }),
    });
    expect(h.enqueueChain).not.toHaveBeenCalled();
    expect(run?.status).toBe('SKIPPED');
    expect(run?.actionResults).toEqual([
      expect.objectContaining({ status: 'SKIPPED', reason: 'NO_CONTACT' }),
    ]);
    expect(logs).toEqual([
      expect.objectContaining({
        status: 'SKIPPED',
        skipReason: 'NO_CONTACT',
        ruleId: run?.ruleId,
        documentId: 'doc-wo-1',
        counterpartyId: CP,
      }),
    ]);
  });

  // guards: BR-AUT-012
  it('службове не йде клієнту, що відмовився; маркетингове — лише за згодою', async () => {
    const refused = await fire({ ctx: fakeCtx({ client: client({ noServiceMessages: true }) }) });
    expect(refused.h.enqueueChain).not.toHaveBeenCalled();
    expect(refused.logs[0]).toMatchObject({ status: 'SKIPPED', skipReason: 'NO_SERVICE_MESSAGES' });

    const noConsent = await fire({ rule: { messageKind: 'MARKETING' } });
    expect(noConsent.h.enqueueChain).not.toHaveBeenCalled();
    expect(noConsent.logs[0]).toMatchObject({ skipReason: 'NO_MARKETING_CONSENT' });

    const consent = await fire({
      rule: { messageKind: 'MARKETING' },
      ctx: fakeCtx({ client: client({ marketingConsent: true, noServiceMessages: true }) }),
    });
    expect(consent.h.enqueueChain).toHaveBeenCalledTimes(1);
  });

  // guards: BR-AUT-011
  it('канали — у порядку правила, лише налаштовані у філії й з адресою одержувача', async () => {
    const { h } = await fire({
      rule: { actions: [clientMessage({ channels: ['EMAIL', 'TELEGRAM', 'SMS', 'VIBER'] })] },
      channels: ['SMS', 'VIBER', 'EMAIL'],
      ctx: fakeCtx({ client: client({ email: null }) }),
    });
    const chain = h.enqueueChain.mock.calls[0]![2] as { channel: string }[];
    // EMAIL — без адреси, TELEGRAM — не налаштовано; порядок SMS → VIBER — як у правилі.
    expect(chain.map(c => c.channel)).toEqual(['SMS', 'VIBER']);
    expect(h.resolveChannels).toHaveBeenCalledWith('org-a', fakeCtx().messageBranchId, [
      'TELEGRAM',
      'SMS',
      'VIBER',
    ]);
  });

  // Рішення власника 2026-10-29: «Я налаштовую самостійно пріоритет, немає фіксованих».
  // guards: BR-AUT-011
  it('правило без каналів — усі налаштовані канали філії в пріоритеті власника', async () => {
    const noChannels = { actions: [{ type: 'client_message', template: { body: 'Привіт' } }] };
    const { h, run } = await fire({ rule: noChannels, channels: ['SMS', 'EMAIL', 'VIBER'] });
    expect(h.resolveChannels).toHaveBeenCalledWith('org-a', fakeCtx().messageBranchId, null);
    const chain = h.enqueueChain.mock.calls[0]![2] as { channel: string; recipient: string }[];
    expect(chain.map(c => [c.channel, c.recipient])).toEqual([
      ['SMS', '+380671112233'],
      ['EMAIL', 'ivan@example.com'],
      ['VIBER', '+380671112233'],
    ]);
    expect(run?.actionResults).toEqual([
      expect.objectContaining({ status: 'DONE', channels: ['SMS', 'EMAIL', 'VIBER'] }),
    ]);

    // Канал без адреси одержувача пропускається; жодного з адресою — «немає контакту».
    const noEmail = await fire({
      rule: noChannels,
      channels: ['EMAIL', 'SMS'],
      ctx: fakeCtx({ client: client({ email: null }) }),
    });
    expect(
      (noEmail.h.enqueueChain.mock.calls[0]![2] as { channel: string }[]).map(c => c.channel),
    ).toEqual(['SMS']);
    const onlyEmail = await fire({
      rule: noChannels,
      channels: ['EMAIL'],
      ctx: fakeCtx({ client: client({ email: null }) }),
    });
    expect(onlyEmail.logs[0]).toMatchObject({ status: 'SKIPPED', skipReason: 'NO_CONTACT' });
    // У філії нічого не налаштовано — «немає каналу».
    const none = await fire({ rule: noChannels, channels: [] });
    expect(none.logs[0]).toMatchObject({ status: 'SKIPPED', skipReason: 'NO_CHANNEL' });
  });

  // guards: BR-AUT-011
  it('Telegram-бот у правилі, а в організації бота не підключено: лише бот — SKIPPED «бот не підключено», бот і SMS — SMS; жоден канал не налаштовано — NO_CHANNEL', async () => {
    const bot = await fire({ rule: { actions: [clientMessage({ channels: ['TELEGRAM_BOT'] })] } });
    expect(bot.h.enqueueChain).not.toHaveBeenCalled();
    expect(bot.logs[0]).toMatchObject({ skipReason: 'TELEGRAM_BOT_NOT_CONNECTED' });

    const botThenSms = await fire({
      rule: { actions: [clientMessage({ channels: ['TELEGRAM_BOT', 'SMS'] })] },
    });
    expect(
      (botThenSms.h.enqueueChain.mock.calls[0]![2] as { channel: string }[]).map(c => c.channel),
    ).toEqual(['SMS']);

    const none = await fire({ channels: [] });
    expect(none.logs[0]).toMatchObject({ status: 'SKIPPED', skipReason: 'NO_CHANNEL' });
  });

  // guards: BR-AUT-013
  it('подія в тихі години — повідомлення в чергу з паузою до кінця вікна (Київ)', async () => {
    // 29.10.2026 — зимовий час (+02:00): 23:30 Києва = 21:30Z; кінець вікна 09:00 30.10 = 07:00Z.
    const now = new Date('2026-10-29T21:30:00.000Z');
    vi.useFakeTimers({ now, toFake: ['Date'] });
    try {
      const { h, run } = await fire({ occurredAt: now });
      const opts = h.enqueueChain.mock.calls[0]![3] as { delayMs: number };
      expect(opts.delayMs).toBe(9.5 * 3_600_000);
      expect(run?.actionResults).toEqual([
        expect.objectContaining({ status: 'DONE', delayedUntil: '2026-10-30T07:00:00.000Z' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  // guards: BR-AUT-013
  it('поза тихими годинами — без паузи', async () => {
    const now = new Date('2026-10-29T10:00:00.000Z');
    vi.useFakeTimers({ now, toFake: ['Date'] });
    try {
      const { h } = await fire({ quiet: ['21:00', '09:00'] });
      expect((h.enqueueChain.mock.calls[0]![3] as { delayMs: number }).delayMs).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // guards: BR-AUT-051
  it('тест: на телефон того, хто тестує, без перевірки згоди й тихих годин; isTest у журналі', async () => {
    const h = automationHarness();
    const ctx = fakeCtx({ client: client({ noServiceMessages: true }) });
    const run: ActionRun = {
      orgId: 'org-a',
      rule: { id: 'rule-t', messageKind: 'SERVICE' },
      ctx,
      vars: eventVars(ctx, new Date()),
      actorId: ACTOR,
      occurredAt: new Date(),
      now: new Date('2026-10-29T21:30:00.000Z'), // у тихі години
      test: { phone: '+380679999999', email: null, telegramChatId: null },
    };
    const res = await h.actions.clientMessage(0, clientMessage() as never, run);
    expect(res.status).toBe('DONE');
    const [, , chain, opts] = h.enqueueChain.mock.calls[0]!;
    expect((chain as { recipient: string }[]).every(c => c.recipient === '+380679999999')).toBe(
      true,
    );
    expect(opts).toMatchObject({ delayMs: 0, meta: { isTest: true, ruleId: 'rule-t' } });
  });
});

describe('NotificationsService — черга й канали правила', () => {
  const registry = {
    get: vi.fn((code: string) =>
      code === 'esputnik' ? { templateChannels: ['VIBER', 'TELEGRAM'] } : { templateChannels: [] },
    ),
  } as unknown as NotificationProviderRegistry;

  // guards: BR-AUT-015, BR-AUT-013
  it('enqueueChain: черга `sms` з ≥ 10 спробами й експоненційною паузою; тихі години — delay', async () => {
    const add = vi.fn().mockResolvedValue({});
    const svc = new NotificationsService(
      {} as PrismaService,
      registry,
      { add } as unknown as Queue,
      {} as TelegramRecipientsService,
    );
    const step = {
      channel: 'SMS' as const,
      provider: 'turbosms',
      senderName: 'STO',
      message: 'x',
      recipient: '+380',
    };
    await svc.enqueueChain('org-a', 'b1', [step], { meta: { ruleId: 'r1' }, delayMs: 5000 });
    const [name, data, opts] = add.mock.calls[0]!;
    expect(name).toBe('send-sms');
    expect(data).toMatchObject({
      orgId: 'org-a',
      branchId: 'b1',
      meta: { ruleId: 'r1' },
      chainIndex: 0,
    });
    expect(opts.attempts).toBeGreaterThanOrEqual(10);
    expect(opts.backoff).toMatchObject({ type: 'exponential' });
    expect(opts.delay).toBe(5000);
    await svc.enqueueChain('org-a', 'b1', [step], {});
    expect(add.mock.calls[1]![2]).not.toHaveProperty('delay');
  });

  // guards: BR-AUT-011
  it('resolveChannels: порядок правила; вимкнений / без ключа / шаблонний без externalTemplateId — пропуск; SMS — legacy', async () => {
    const prisma = {
      notificationChannelConfig: {
        findMany: vi.fn().mockResolvedValue([
          {
            channel: 'VIBER',
            provider: 'esputnik',
            enabled: true,
            apiKey: 'k',
            senderName: null,
            externalTemplateId: null,
          },
          {
            channel: 'TELEGRAM',
            provider: 'esputnik',
            enabled: true,
            apiKey: 'k',
            senderName: 'S',
            externalTemplateId: 'tpl-1',
          },
          {
            channel: 'EMAIL',
            provider: 'smtp',
            enabled: false,
            apiKey: 'k',
            senderName: null,
            externalTemplateId: null,
          },
        ]),
      },
      branchSettings: {
        findFirst: vi.fn().mockResolvedValue({
          smsEnabled: true,
          smsApiKey: 'legacy',
          smsProvider: 'turbosms',
          smsSenderName: 'OLD',
        }),
      },
    } as unknown as PrismaService;
    const svc = new NotificationsService(
      prisma,
      registry,
      { add: vi.fn() } as unknown as Queue,
      {} as TelegramRecipientsService,
    );
    const out = await svc.resolveChannels('org-a', 'b1', ['SMS', 'EMAIL', 'VIBER', 'TELEGRAM']);
    expect(out).toEqual([
      { channel: 'SMS', provider: 'turbosms', senderName: 'OLD' },
      { channel: 'TELEGRAM', provider: 'esputnik', senderName: 'S', externalTemplateId: 'tpl-1' },
    ]);
  });

  // Фейкова таблиця виконує where / orderBy: зниклий `orderBy: priority` чи фільтр філії / org
  // ламає тест, а не проходить мовчки.
  // guards: BR-AUT-011
  it('resolveChannels(null) — «як у філії»: придатні канали за пріоритетом власника; немає — legacy SMS', async () => {
    const cfg = (channel: string, priority: number, over: Record<string, unknown> = {}) => ({
      orgId: 'org-a',
      branchId: 'b1',
      channel,
      priority,
      provider: 'turbosms',
      enabled: true,
      apiKey: 'k',
      senderName: 'STO',
      externalTemplateId: null,
      deletedAt: null,
      ...over,
    });
    const legacy = {
      orgId: 'org-a',
      branchId: 'b1',
      smsEnabled: true,
      smsApiKey: 'legacy',
      smsProvider: 'turbosms',
      smsSenderName: 'OLD',
    };
    const make = (rows: Record<string, unknown>[]) =>
      new NotificationsService(
        {
          notificationChannelConfig: memoryTable(rows),
          branchSettings: memoryTable([legacy]),
        } as unknown as PrismaService,
        registry,
        { add: vi.fn() } as unknown as Queue,
        {} as TelegramRecipientsService,
      );

    const svc = make([
      cfg('VIBER', 2),
      cfg('EMAIL', 0, { provider: 'smtp' }),
      cfg('SMS', 1),
      cfg('TELEGRAM', 3, { provider: 'esputnik' }), // шаблонний без externalTemplateId
      cfg('VIBER', 0, { branchId: 'b2' }), // інша філія
      cfg('SMS', -1, { orgId: 'org-b' }), // інша org
      cfg('EMAIL', -5, { deletedAt: new Date() }),
    ]);
    const order = (await svc.resolveChannels('org-a', 'b1', null)).map(c => c.channel);
    expect(order).toEqual(['EMAIL', 'SMS', 'VIBER']);

    // Жодного придатного конфігу — як зашиті повідомлення до автоматизації: legacy SMS філії.
    const legacyOnly = make([cfg('VIBER', 0, { enabled: false })]);
    expect(await legacyOnly.resolveChannels('org-a', 'b1', null)).toEqual([
      { channel: 'SMS', provider: 'turbosms', senderName: 'OLD' },
    ]);
  });
});
