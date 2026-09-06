import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import type {
  NotificationProvider,
  ProviderCredentials,
  SendParams,
  SendResult,
  VerifyResult,
} from './notification-provider.interface';

const ESPUTNIK_BASE = 'https://esputnik.com/api';
const HTTP_TIMEOUT_MS = 10_000;

/**
 * eSputnik / Yespo (https://esputnik.com) — український CDP-шлюз.
 *  - SMS: direct ad-hoc через POST /api/v1/message/sendsms (inline text + from).
 *  - Viber / Telegram: ТІЛЬКИ через готовий шаблон у кабінеті eSputnik —
 *    POST /api/v1/message/{externalTemplateId}/smartsend (наш inline-текст не застосовується,
 *    текст живе в їхньому шаблоні; передаємо лише отримувача). Без externalTemplateId канал
 *    повертає accepted:false → fallback перескочить далі.
 *  - Telegram: доставка лише підписаним отримувачам (обмеження Telegram, не наше).
 *
 * Auth: HTTP Basic — username будь-що, password = API key (creds.apiKey).
 * Офлайн-інваріант: зовнішній HTTP НІКОЛИ не вішає воркер → AbortController timeout.
 */
@Injectable()
export class EsputnikProvider implements NotificationProvider {
  readonly code = 'esputnik';
  readonly name = 'eSputnik';
  readonly channels: NotificationChannel[] = [
    NotificationChannel.SMS,
    NotificationChannel.VIBER,
    NotificationChannel.TELEGRAM,
  ];
  // Viber/Telegram — лише через готовий шаблон у кабінеті (smartsend); inline-текст ігнорується.
  // SMS — inline (sendsms). Джерело правди для externalTemplateId-вимоги (бек-валідація + UI).
  readonly templateChannels: NotificationChannel[] = [
    NotificationChannel.VIBER,
    NotificationChannel.TELEGRAM,
  ];

  private readonly logger = new Logger(EsputnikProvider.name);

  async send(params: SendParams): Promise<SendResult> {
    const { channel, phone, message, creds, externalTemplateId } = params;

    try {
      if (channel === NotificationChannel.SMS) {
        // Direct ad-hoc SMS — inline text.
        const res = await this.fetchJson('POST', '/v1/message/sendsms', creds.apiKey, {
          from: creds.senderName ?? 'STO ERP',
          text: message,
          phoneNumbers: [phone],
        });
        // sendsms повертає ідентифікатори/статуси; успіх = HTTP 2xx (fetchJson кидає на non-2xx).
        return {
          accepted: true,
          providerMessageId: this.extractMessageId(res),
        };
      }

      if (channel === NotificationChannel.VIBER || channel === NotificationChannel.TELEGRAM) {
        if (!externalTemplateId) {
          return {
            accepted: false,
            error: `eSputnik ${channel}: потрібен ID шаблону (externalTemplateId)`,
          };
        }
        // Template-based: текст у шаблоні eSputnik, ми лише вказуємо отримувача (locator).
        const res = await this.fetchJson(
          'POST',
          `/v1/message/${encodeURIComponent(externalTemplateId)}/smartsend`,
          creds.apiKey,
          { recipients: [{ locator: phone }] },
        );
        return { accepted: true, providerMessageId: this.extractMessageId(res) };
      }

      return { accepted: false, error: `eSputnik: канал ${channel} не підтримується` };
    } catch (e) {
      return {
        accepted: false,
        error: e instanceof Error ? e.message : 'eSputnik: помилка мережі',
      };
    }
  }

  async verifyCredentials(creds: ProviderCredentials): Promise<VerifyResult> {
    try {
      // /v1/account/info — підтверджує валідність токена. Тест-повідомлення не шлемо.
      const res = await this.fetchJson('GET', '/v1/account/info', creds.apiKey);
      // Баланс — якщо API повертає (структура може відрізнятись; беремо толерантно).
      const balanceRaw =
        (res?.balance as unknown) ??
        (res?.creditsBalance as unknown) ??
        (res?.smsBalance as unknown);
      const balance = balanceRaw != null ? Number(balanceRaw) : undefined;
      return { valid: true, balance: Number.isFinite(balance) ? balance : undefined };
    } catch (e) {
      return { valid: false, error: e instanceof Error ? e.message : 'Помилка перевірки' };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractMessageId(res: any): string | undefined {
    // sendsms/smartsend повертають різні форми; беремо перший наявний id.
    const id =
      res?.id ??
      res?.messageId ??
      (Array.isArray(res?.results) ? res.results[0]?.id : undefined) ??
      (Array.isArray(res) ? res[0]?.id : undefined);
    return id != null ? String(id) : undefined;
  }

  /** HTTP-виклик із Basic-auth (password = apiKey) + timeout. Кидає на non-2xx / abort. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async fetchJson(
    method: 'GET' | 'POST',
    path: string,
    apiKey: string,
    body?: Record<string, unknown>,
  ): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    // Basic auth: username будь-що (за докою), password = apiKey.
    const authHeader = `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`;
    let response: Response;
    try {
      response = await fetch(`${ESPUTNIK_BASE}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`eSputnik ${response.status}: ${err}`);
    }
    // account/info та send повертають JSON; порожнє тіло толеруємо.
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
}
