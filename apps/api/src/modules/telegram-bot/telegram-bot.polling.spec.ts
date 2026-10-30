/**
 * Опитування `getUpdates` власного Telegram-бота (docs/objects/automation.md, BR-AUT-041, 015):
 * offset — щоб оновлення не оброблялись повторно після рестарту; без інтернету тік тихо
 * завершується, процес не падає; повторна обробка того самого оновлення — без дубля підписки.
 */
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  TelegramApiError,
  TelegramNetworkError,
} from '../notifications/providers/telegram-api.client';
import { TelegramBotProcessor } from './telegram-bot.processor';
import { ORG, TOKEN, botHarness, linkCode, textUpdate } from './telegram-bot.spec-fixture';

describe('Опитування getUpdates (BR-AUT-041)', () => {
  // guards: BR-AUT-041
  it('offset: перше опитування без offset, далі — наступний update_id після обробленого', async () => {
    const h = botHarness();
    const a = textUpdate('/stop');
    const b = textUpdate('/stop');
    h.api.getUpdates.mockResolvedValueOnce([b, a]); // порядок у відповіді — не гарантія
    expect(await h.service.poll(ORG)).toEqual({ processed: 2 });
    expect(h.api.getUpdates).toHaveBeenLastCalledWith(TOKEN, null);
    expect(h.tables.organisationSettings.rows[0]!.telegramBotUpdateOffset).toBe(
      BigInt(b.update_id + 1),
    );

    await h.service.poll(ORG);
    expect(h.api.getUpdates).toHaveBeenLastCalledWith(TOKEN, b.update_id + 1);
  });

  // guards: BR-AUT-041
  it('offset збережено в налаштуваннях — після рестарту (новий сервіс) опитування йде з нього', async () => {
    const h = botHarness({ offset: BigInt(4242) });
    await h.service.poll(ORG);
    expect(h.api.getUpdates).toHaveBeenCalledWith(TOKEN, 4242);
  });

  // guards: BR-AUT-041
  it('паралельний тік уже зсунув offset — умовний запис не відкочує його назад', async () => {
    const h = botHarness({ offset: BigInt(100) });
    h.api.getUpdates.mockImplementationOnce(() => {
      // Інший екземпляр api встиг обробити й записати offset, поки цей тік опитував.
      h.tables.organisationSettings.rows[0]!.telegramBotUpdateOffset = BigInt(900);
      return Promise.resolve([textUpdate('/stop')]);
    });
    await h.service.poll(ORG);
    expect(h.tables.organisationSettings.rows[0]!.telegramBotUpdateOffset).toBe(BigInt(900));
  });

  // guards: BR-AUT-041
  it('те саме оновлення вдруге (рестарт до запису offset) — одна підписка, код використано раз', async () => {
    const code = linkCode();
    const h = botHarness({ codes: [code] });
    const update = textUpdate(`/start ${String(code.code)}`);
    h.api.getUpdates.mockResolvedValueOnce([update]).mockResolvedValueOnce([update]);
    await h.service.poll(ORG);
    const usedAt = h.tables.telegramLinkCode.rows[0]!.usedAt;
    await h.service.poll(ORG);
    expect(h.tables.telegramSubscription.rows).toHaveLength(1);
    expect(h.tables.telegramLinkCode.rows[0]!.usedAt).toBe(usedAt);
  });

  // guards: BR-AUT-015, BR-AUT-041
  it('без інтернету — тік тихо завершується (не кидає), offset не змінено, попередження один раз', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const h = botHarness({ offset: BigInt(77) });
      h.api.getUpdates
        .mockRejectedValueOnce(new TelegramNetworkError('fetch failed'))
        .mockRejectedValueOnce(new TelegramNetworkError('fetch failed'))
        .mockRejectedValueOnce(new TelegramApiError(409, 'Conflict'));
      for (let i = 0; i < 3; i += 1)
        await expect(h.service.poll(ORG)).resolves.toEqual({ processed: 0 });
      expect(h.tables.organisationSettings.rows[0]!.telegramBotUpdateOffset).toBe(BigInt(77));
      expect(warn).toHaveBeenCalledTimes(1);
      // Зв'язок повернувся — опитування працює далі з того самого offset.
      await h.service.poll(ORG);
      expect(h.api.getUpdates).toHaveBeenLastCalledWith(TOKEN, 77);
    } finally {
      warn.mockRestore();
    }
  });

  // guards: BR-AUT-041
  it('бота не підключено — Telegram не опитується; збій одного оновлення не блокує решту', async () => {
    const off = botHarness({ token: null });
    await off.service.poll(ORG);
    expect(off.api.getUpdates).not.toHaveBeenCalled();

    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const h = botHarness();
      const broken = textUpdate('/stop');
      const ok = textUpdate('/stop');
      h.enqueueChain.mockRejectedValueOnce(new Error('Redis недоступний'));
      h.api.getUpdates.mockResolvedValueOnce([broken, ok]);
      await h.service.poll(ORG);
      expect(h.enqueueChain).toHaveBeenCalledTimes(2);
      expect(h.tables.organisationSettings.rows[0]!.telegramBotUpdateOffset).toBe(
        BigInt(ok.update_id + 1),
      );
    } finally {
      error.mockRestore();
    }
  });

  // guards: BR-AUT-041, BR-AUT-052
  it('job черги `telegram-bot` опитує саме свою організацію', async () => {
    const h = botHarness();
    const processor = new TelegramBotProcessor(h.service);
    await processor.process({ data: { orgId: ORG } } as never);
    expect(h.api.getUpdates).toHaveBeenCalledWith(TOKEN, null);
  });
});
