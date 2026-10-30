import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { redactSecrets } from '../../../common/utils/redact';

/** Типова адреса Bot API; `TELEGRAM_API_URL` у env — для тестів і живої перевірки на фейку. */
export const TELEGRAM_API_DEFAULT_URL = 'https://api.telegram.org';
const HTTP_TIMEOUT_MS = 10_000;

/** Telegram відповів `ok: false` (невірний токен, чат не знайдено, бота заблоковано…). */
export class TelegramApiError extends Error {
  constructor(
    readonly errorCode: number,
    readonly description: string,
  ) {
    super(`Telegram ${errorCode}: ${description}`);
    this.name = 'TelegramApiError';
  }
}

/** Telegram недоступний: немає мережі, тайм-аут, не-JSON відповідь (офлайн СТО). */
export class TelegramNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramNetworkError';
  }
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: TelegramUser;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

/**
 * Мінімальний клієнт Telegram Bot API (власний бот СТО, BR-AUT-040, 041). Токен — у шляху запиту,
 * тому в жодне повідомлення про помилку він не потрапляє (`redactSecrets`). Тайм-аут на кожен
 * запит: зовнішній HTTP не має вішати воркер черги (офлайн-вимога).
 */
@Injectable()
export class TelegramApiClient {
  constructor(private readonly config: ConfigService) {}

  getMe(token: string): Promise<TelegramUser> {
    return this.call<TelegramUser>(token, 'getMe', {});
  }

  /** Коротке опитування (`timeout: 0`): job опитування не тримає воркер і не перекривається. */
  getUpdates(token: string, offset: number | null): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(token, 'getUpdates', {
      ...(offset !== null && { offset }),
      timeout: 0,
      allowed_updates: ['message'],
    });
  }

  sendMessage(token: string, chatId: string, text: string): Promise<TelegramMessage> {
    return this.call<TelegramMessage>(token, 'sendMessage', { chat_id: chatId, text });
  }

  private baseUrl(): string {
    const configured = this.config.get<string>('TELEGRAM_API_URL');
    let url = configured || TELEGRAM_API_DEFAULT_URL;
    while (url.endsWith('/')) url = url.slice(0, -1);
    return url;
  }

  private async call<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl()}/bot${token}/${method}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new TelegramNetworkError(
        `Telegram недоступний (${method}): ${redactSecrets(reason, [token])}`,
      );
    } finally {
      clearTimeout(timer);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TelegramNetworkError(`Telegram ${response.status} (${method}): відповідь не JSON`);
    }
    const res = payload as { ok?: boolean; result?: T; error_code?: number; description?: string };
    if (res?.ok === true) return res.result as T;
    if (typeof res?.error_code === 'number') {
      throw new TelegramApiError(
        res.error_code,
        redactSecrets(String(res.description ?? ''), [token]),
      );
    }
    throw new TelegramNetworkError(`Telegram ${response.status} (${method}): невідома відповідь`);
  }
}
