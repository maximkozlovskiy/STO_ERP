/**
 * Маршрути власного Telegram-бота (docs/objects/automation.md, BR-AUT-040, 041): ролі, формат
 * токена (токен іде в шлях запиту до Bot API — сміття туди не пускаємо), відповідь без токена.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import {
  CounterpartyTelegramController,
  EmployeeTelegramController,
  TelegramBotSettingsController,
} from './telegram-bot.controller';
import { ConnectTelegramBotDto } from './telegram-bot.dto';

const rolesOf = (cls: { prototype: object }, method: string): string[] =>
  [
    ...((Reflect.getMetadata(ROLES_KEY, (cls.prototype as Record<string, object>)[method]!) as
      string[] | undefined) ?? []),
  ].sort();

const STAFF = [
  'ACCOUNTANT',
  'ADMIN',
  'MECHANIC',
  'OWNER',
  'RECEPTIONIST',
  'STOREKEEPER',
  'XLSX_MANAGER',
];

describe('Ролі маршрутів Telegram-бота', () => {
  // guards: BR-AUT-040
  it.each(['status', 'connect', 'disconnect'])('налаштування бота (%s) — лише OWNER і ADMIN', m => {
    expect(rolesOf(TelegramBotSettingsController, m)).toEqual(['ADMIN', 'OWNER']);
  });

  // guards: BR-AUT-041
  it('підписка клієнта — хто веде картку контрагента; працівника — OWNER/ADMIN; своя — будь-хто', () => {
    for (const m of ['createLink', 'unsubscribe']) {
      expect(rolesOf(CounterpartyTelegramController, m)).toEqual([
        'ADMIN',
        'OWNER',
        'RECEPTIONIST',
      ]);
      expect(rolesOf(EmployeeTelegramController, m)).toEqual(['ADMIN', 'OWNER']);
    }
    for (const m of ['createMyLink', 'mySubscription', 'unsubscribeMe']) {
      expect(rolesOf(EmployeeTelegramController, m)).toEqual(STAFF);
    }
  });
});

describe('Токен бота (BR-AUT-040)', () => {
  const errorsOf = (token: unknown) =>
    validateSync(plainToInstance(ConnectTelegramBotDto, { token })).flatMap(e =>
      Object.values(e.constraints ?? {}),
    );

  // guards: BR-AUT-040
  it('формат BotFather приймається (пробіли по краях обрізаються)', () => {
    expect(errorsOf('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw')).toEqual([]);
    expect(errorsOf('  123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw\n')).toEqual([]);
  });

  // guards: BR-AUT-040
  it.each([
    ['без двокрапки', 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'],
    ['шлях у токені', '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5/../getMe'],
    ['запит у токені', '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5?x=1'],
    ['закороткий секрет', '123456789:short'],
    ['не рядок', 123],
  ])('%s — 400 «Telegram не прийняв токен»', (_name, token) => {
    expect(errorsOf(token)).toContain('err.telegramBot.invalidToken');
  });
});
