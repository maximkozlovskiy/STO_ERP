import { Injectable } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { TELEGRAM_BOT_PROVIDER } from '@sto/shared';
import type {
  NotificationProvider,
  ProviderCredentials,
  SendParams,
  SendResult,
  VerifyResult,
} from './notification-provider.interface';
import { TelegramApiClient, TelegramApiError } from './telegram-api.client';

/** 403 — користувач заблокував бота чи не починав із ним розмови: надсилати марно. */
const FORBIDDEN = 403;
/** 429 — забагато запитів: тимчасово, повтор черги має сенс. */
const TOO_MANY_REQUESTS = 429;

/**
 * Власний Telegram-бот організації (BR-AUT-022, 040, 041): довільний текст за chat id підписки.
 * `creds.apiKey` — токен бота з налаштувань організації (резолвиться в `SmsProcessor`, не з
 * конфігу каналу філії): рядок каналу TELEGRAM_BOT у філії лише ставить бота в пріоритет.
 */
@Injectable()
export class TelegramBotProvider implements NotificationProvider {
  readonly code = TELEGRAM_BOT_PROVIDER;
  readonly name = 'Telegram-бот СТО';
  readonly channels: NotificationChannel[] = [NotificationChannel.TELEGRAM_BOT];
  readonly orgCredentials = true;

  constructor(private readonly api: TelegramApiClient) {}

  async send(params: SendParams): Promise<SendResult> {
    if (params.channel !== NotificationChannel.TELEGRAM_BOT) {
      return { accepted: false, permanent: true, error: `Telegram-бот: канал ${params.channel}` };
    }
    try {
      const msg = await this.api.sendMessage(params.creds.apiKey, params.recipient, params.message);
      return { accepted: true, providerMessageId: String(msg.message_id) };
    } catch (e: unknown) {
      if (e instanceof TelegramApiError) {
        const transient = e.errorCode === TOO_MANY_REQUESTS || e.errorCode >= 500;
        return {
          accepted: false,
          error: e.message,
          permanent: !transient,
          recipientBlocked: e.errorCode === FORBIDDEN,
        };
      }
      return {
        accepted: false,
        error: e instanceof Error ? e.message : 'Telegram: помилка мережі',
      };
    }
  }

  async verifyCredentials(creds: ProviderCredentials): Promise<VerifyResult> {
    try {
      const me = await this.api.getMe(creds.apiKey);
      return { valid: true, senderNames: me.username ? [me.username] : [] };
    } catch (e: unknown) {
      return { valid: false, error: e instanceof Error ? e.message : 'Помилка перевірки' };
    }
  }
}
