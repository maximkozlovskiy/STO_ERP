/**
 * Підключення власного Telegram-бота (docs/objects/automation.md, BR-AUT-040): перевірка токена
 * `getMe`, невірний токен і «немає мережі» — різні 400 українською, токен назовні не віддається,
 * відключення зупиняє опитування.
 */
import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { translateError } from '@sto/shared';
import {
  TelegramApiError,
  TelegramNetworkError,
} from '../notifications/providers/telegram-api.client';
import { ADMIN, ORG, TOKEN, botHarness } from './telegram-bot.spec-fixture';

const NEW_TOKEN = '654321:another-telegram-token-bbbbbbbbb';

describe('Підключення Telegram-бота (BR-AUT-040)', () => {
  // guards: BR-AUT-040
  it('getMe прийняв токен — токен і ім’я бота збережено, опитування поставлено; відповідь без токена', async () => {
    const h = botHarness({ token: null });
    const res = await h.service.connect(ORG, NEW_TOKEN, ADMIN);
    expect(h.api.getMe).toHaveBeenCalledWith(NEW_TOKEN);
    expect(res).toEqual({ connected: true, username: 'sto_test_bot' });
    expect(JSON.stringify(res)).not.toContain(NEW_TOKEN);
    expect(h.tables.organisationSettings.rows[0]).toMatchObject({
      telegramBotToken: NEW_TOKEN,
      telegramBotUsername: 'sto_test_bot',
    });
    expect(h.scheduler.start).toHaveBeenCalledWith(ORG);
    // Аудит — лише ім'я бота, не токен.
    expect(JSON.stringify(h.audit.record.mock.calls)).not.toContain(NEW_TOKEN);
  });

  // guards: BR-AUT-040
  it('невірний токен і немає зв’язку з Telegram — різні 400 українською; нічого не збережено', async () => {
    const h = botHarness({ token: null });
    h.api.getMe.mockRejectedValueOnce(new TelegramApiError(401, 'Unauthorized'));
    const invalid = await h.service.connect(ORG, NEW_TOKEN, ADMIN).catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(BadRequestException);
    expect((invalid as Error).message).toBe(translateError('err.telegramBot.invalidToken', 'uk'));

    h.api.getMe.mockRejectedValueOnce(new TelegramNetworkError('fetch failed'));
    const offline = await h.service.connect(ORG, NEW_TOKEN, ADMIN).catch((e: unknown) => e);
    expect(offline).toBeInstanceOf(BadRequestException);
    expect((offline as Error).message).toBe(translateError('err.telegramBot.unreachable', 'uk'));
    expect((offline as Error).message).not.toBe((invalid as Error).message);

    // Токен не бота (getMe без is_bot) — теж «невірний токен».
    h.api.getMe.mockResolvedValueOnce({ id: 1, is_bot: false });
    await expect(h.service.connect(ORG, NEW_TOKEN, ADMIN)).rejects.toThrow(
      translateError('err.telegramBot.invalidToken', 'uk'),
    );

    expect(h.tables.organisationSettings.rows[0]!.telegramBotToken).toBeNull();
    expect(h.scheduler.start).not.toHaveBeenCalled();
  });

  // guards: BR-AUT-040
  it('стан — лише «підключено» й ім’я бота; токен не віддається ніколи', async () => {
    const h = botHarness();
    const res = await h.service.status(ORG);
    expect(res).toEqual({ connected: true, username: 'sto_test_bot' });
    expect(JSON.stringify(res)).not.toContain(TOKEN);
    expect(await botHarness({ token: null }).service.status(ORG)).toEqual({
      connected: false,
      username: null,
    });
  });

  // guards: BR-AUT-040, BR-AUT-041
  it('інший токен — offset скинуто (інша послідовність оновлень); той самий — offset лишається', async () => {
    const same = botHarness({ offset: BigInt(5000) });
    await same.service.connect(ORG, TOKEN, ADMIN);
    expect(same.tables.organisationSettings.rows[0]!.telegramBotUpdateOffset).toBe(BigInt(5000));

    const other = botHarness({ offset: BigInt(5000) });
    await other.service.connect(ORG, NEW_TOKEN, ADMIN);
    expect(other.tables.organisationSettings.rows[0]!.telegramBotUpdateOffset).toBeNull();
  });

  // guards: BR-AUT-040
  it('відключення — токен, ім’я й offset стерто, опитування знято; інша org не зачеплена', async () => {
    const h = botHarness({ offset: BigInt(10) });
    expect(await h.service.disconnect(ORG, ADMIN)).toEqual({ connected: false, username: null });
    expect(h.tables.organisationSettings.rows[0]).toMatchObject({
      telegramBotToken: null,
      telegramBotUsername: null,
      telegramBotUpdateOffset: null,
    });
    expect(h.tables.organisationSettings.rows[1]!.telegramBotToken).toBe('other');
    expect(h.scheduler.stop).toHaveBeenCalledWith(ORG);
  });
});
