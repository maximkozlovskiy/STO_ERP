/**
 * Підписка на власний Telegram-бот (docs/objects/automation.md, BR-AUT-041, 052): одноразовий код
 * на 7 днів, `/start <код>` прив'язує chat id, `/stop` відписує; прострочений, використаний, чужий
 * код — відмова з поясненням; повторне `/start` того самого чату — ідемпотентне.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import {
  ADMIN,
  CHAT,
  CP,
  EMP,
  FIRED_EMP,
  FOREIGN_CP,
  ORG,
  OTHER_ORG,
  botHarness,
  linkCode,
  textUpdate,
} from './telegram-bot.spec-fixture';

const text = (key: string) => translateError(key, 'uk', { org: 'СТО Тест' });

/** Один тік опитування з цими оновленнями. */
async function deliver(
  h: ReturnType<typeof botHarness>,
  ...updates: ReturnType<typeof textUpdate>[]
) {
  h.api.getUpdates.mockResolvedValueOnce(updates);
  await h.service.poll(ORG);
}

afterEach(() => vi.useRealTimers());

describe('Код підписки (BR-AUT-041)', () => {
  // guards: BR-AUT-041
  it('криптостійкий одноразовий код на 7 днів; посилання t.me/<бот>?start=<код>', async () => {
    const now = new Date('2026-10-30T10:00:00.000Z');
    vi.useFakeTimers({ now, toFake: ['Date'] });
    const h = botHarness();
    const a = await h.service.createLink(ORG, { kind: 'counterparty', id: CP }, ADMIN);
    const b = await h.service.createLink(ORG, { kind: 'counterparty', id: CP }, ADMIN);
    expect(a.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.code).not.toBe(b.code);
    expect(a.url).toBe(`https://t.me/sto_test_bot?start=${a.code}`);
    expect(a.expiresAt).toBe('2026-11-06T10:00:00.000Z');
    expect(h.tables.telegramLinkCode.rows[0]).toMatchObject({
      orgId: ORG,
      code: a.code,
      counterpartyId: CP,
      createdById: ADMIN,
      usedAt: null,
    });
  });

  // guards: BR-AUT-041, BR-AUT-052
  it('бот не підключено — 400; чужий контрагент — 404; працівник — код на працівника', async () => {
    await expect(
      botHarness({ token: null }).service.createLink(ORG, { kind: 'counterparty', id: CP }, ADMIN),
    ).rejects.toThrow(
      new BadRequestException(translateError('err.telegramBot.notConnected', 'uk')),
    );
    const h = botHarness();
    await expect(
      h.service.createLink(ORG, { kind: 'counterparty', id: FOREIGN_CP }, ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
    await h.service.createLink(ORG, { kind: 'employee', id: EMP }, EMP);
    expect(h.tables.telegramLinkCode.rows[0]).toMatchObject({ employeeId: EMP });
    expect(h.tables.telegramLinkCode.rows[0]!.counterpartyId).toBeUndefined();
  });
});

describe('/start і /stop (BR-AUT-041)', () => {
  // guards: BR-AUT-041
  it('/start <код> — підписка активна з chat id, код використано, бот підтверджує', async () => {
    const code = linkCode();
    const h = botHarness({ codes: [code] });
    await deliver(h, textUpdate(`/start ${String(code.code)}`));
    expect(h.tables.telegramSubscription.rows).toEqual([
      expect.objectContaining({
        orgId: ORG,
        counterpartyId: CP,
        chatId: String(CHAT),
        active: true,
      }),
    ]);
    expect(h.tables.telegramLinkCode.rows[0]!.usedAt).toBeInstanceOf(Date);
    expect(h.replies()).toEqual([
      { chat: String(CHAT), text: text('bot.telegram.subscribed'), channel: 'TELEGRAM_BOT' },
    ]);
  });

  // guards: BR-AUT-041
  it('прострочений код — відмова з поясненням, підписки немає, код не використано', async () => {
    const code = linkCode({ expiresAt: new Date(Date.now() - 1000) });
    const h = botHarness({ codes: [code] });
    await deliver(h, textUpdate(`/start ${String(code.code)}`));
    expect(h.tables.telegramSubscription.rows).toEqual([]);
    expect(h.tables.telegramLinkCode.rows[0]!.usedAt).toBeNull();
    expect(h.replies()[0]!.text).toBe(text('bot.telegram.codeExpired'));
  });

  // guards: BR-AUT-041
  it('код уже використав інший чат — «використано»; той самий чат повторно — те саме підтвердження, одна підписка', async () => {
    const code = linkCode();
    const h = botHarness({ codes: [code] });
    await deliver(h, textUpdate(`/start ${String(code.code)}`));
    await deliver(h, textUpdate(`/start ${String(code.code)}`, 999));
    await deliver(h, textUpdate(`/start ${String(code.code)}`));
    expect(h.replies().map(r => [r.chat, r.text])).toEqual([
      [String(CHAT), text('bot.telegram.subscribed')],
      ['999', text('bot.telegram.codeUsed')],
      [String(CHAT), text('bot.telegram.subscribed')],
    ]);
    expect(h.tables.telegramSubscription.rows).toHaveLength(1);
  });

  // guards: BR-AUT-041, BR-AUT-052
  it('код чужої організації, невідомий, видалений, на звільненого — «посилання недійсне»', async () => {
    // Чужий код, навіть якщо id цілі збігся з нашим контрагентом: межа — orgId самого коду.
    const foreign = linkCode({ orgId: OTHER_ORG, counterpartyId: CP });
    const deleted = linkCode({ deletedAt: new Date() });
    const fired = linkCode({ counterpartyId: null, employeeId: FIRED_EMP });
    const h = botHarness({ codes: [foreign, deleted, fired] });
    await deliver(
      h,
      textUpdate(`/start ${String(foreign.code)}`),
      textUpdate('/start NOSUCHCODE'),
      textUpdate(`/start ${String(deleted.code)}`),
      textUpdate(`/start ${String(fired.code)}`),
      textUpdate('/start ../../etc'),
    );
    expect(h.replies().map(r => r.text)).toEqual(Array(5).fill(text('bot.telegram.codeUnknown')));
    expect(h.tables.telegramSubscription.rows).toEqual([]);
    expect(h.tables.telegramLinkCode.rows.every(r => r.usedAt === null)).toBe(true);
  });

  // guards: BR-AUT-041
  it('/start без коду — підказка; групові чати й звичайний текст — без відповіді', async () => {
    const code = linkCode();
    const h = botHarness({ codes: [code] });
    await deliver(
      h,
      textUpdate('/start'),
      textUpdate(`/start ${String(code.code)}`, -100500, 'group'),
      textUpdate('Добрий день'),
    );
    expect(h.replies()).toEqual([
      { chat: String(CHAT), text: text('bot.telegram.startHint'), channel: 'TELEGRAM_BOT' },
    ]);
    expect(h.tables.telegramSubscription.rows).toEqual([]);
  });

  // guards: BR-AUT-041, BR-AUT-052
  it('/stop — підписки цього чату в org вимкнено, підтвердження; чужа org і інший чат не зачеплені', async () => {
    const sub = (id: string, over: Record<string, unknown>) => ({
      id,
      orgId: ORG,
      chatId: String(CHAT),
      active: true,
      deletedAt: null,
      subscribedAt: new Date(),
      ...over,
    });
    const h = botHarness({
      subscriptions: [
        sub('s-client', { counterpartyId: CP }),
        sub('s-emp', { employeeId: EMP }),
        sub('s-other-chat', { counterpartyId: CP, chatId: '555' }),
        sub('s-other-org', { orgId: OTHER_ORG, counterpartyId: FOREIGN_CP }),
      ],
    });
    await deliver(h, textUpdate('/stop'));
    expect(h.tables.telegramSubscription.rows.map(r => [r.id, r.active])).toEqual([
      ['s-client', false],
      ['s-emp', false],
      ['s-other-chat', true],
      ['s-other-org', true],
    ]);
    expect(h.tables.telegramSubscription.rows[0]!.unsubscribedAt).toBeInstanceOf(Date);
    expect(h.replies()[0]!.text).toBe(text('bot.telegram.unsubscribed'));
  });

  // guards: BR-AUT-041
  it('після /stop новий код знову активує ту саму підписку (без дубля); відписка з адмінки', async () => {
    const first = linkCode();
    const second = linkCode();
    const h = botHarness({ codes: [first, second] });
    await deliver(h, textUpdate(`/start ${String(first.code)}`));
    await deliver(h, textUpdate('/stop'));
    await deliver(h, textUpdate(`/start ${String(second.code)}`));
    expect(h.tables.telegramSubscription.rows).toHaveLength(1);
    expect(await h.service.subscription(ORG, { kind: 'counterparty', id: CP })).toMatchObject({
      active: true,
    });

    expect(await h.service.unsubscribe(ORG, { kind: 'counterparty', id: CP })).toEqual({
      active: false,
      subscribedAt: null,
    });
    expect(h.tables.telegramSubscription.rows[0]!.active).toBe(false);
  });
});
