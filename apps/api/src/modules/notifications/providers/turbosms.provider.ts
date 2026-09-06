import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import type {
  NotificationProvider,
  ProviderCredentials,
  SendParams,
  SendResult,
  VerifyResult,
} from './notification-provider.interface';

const TURBOSMS_BASE = 'https://api.turbosms.ua';
const HTTP_TIMEOUT_MS = 10_000;

/**
 * TurboSMS (https://turbosms.ua) — український шлюз. Уміє SMS і Viber (Phase 2).
 * Офлайн-інваріант: зовнішній HTTP НІКОЛИ не має вішати воркер → AbortController timeout.
 */
@Injectable()
export class TurboSmsProvider implements NotificationProvider {
  readonly code = 'turbosms';
  readonly name = 'TurboSMS';
  // TurboSMS уміє SMS і Viber (окремі payload-об'єкти у /message/send.json).
  readonly channels: NotificationChannel[] = [NotificationChannel.SMS, NotificationChannel.VIBER];

  private readonly logger = new Logger(TurboSmsProvider.name);

  async send(params: SendParams): Promise<SendResult> {
    const { channel, phone, message, creds } = params;
    const sender = creds.senderName ?? 'STO ERP';

    // Наш бекенд керує fallback-ланцюгом, тож шлемо кожен канал ОКРЕМО (без вбудованого
    // viber-to-sms провайдера). SMS → {sms:{...}}, Viber → {viber:{...}}.
    let payload: Record<string, unknown>;
    if (channel === NotificationChannel.SMS) {
      payload = { recipients: [phone], sms: { sender, text: message }, token: creds.apiKey };
    } else if (channel === NotificationChannel.VIBER) {
      payload = { recipients: [phone], viber: { sender, text: message }, token: creds.apiKey };
    } else {
      return { accepted: false, error: `TurboSMS: канал ${channel} не підтримується` };
    }

    try {
      const res = await this.fetchJson('/message/send.json', payload);
      // TurboSMS: response_code 0/800 = OK; кожен recipient має message_id + response_status.
      const rec = Array.isArray(res?.response_result) ? res.response_result[0] : undefined;
      const okCodes = new Set([0, 800]);
      const accepted = rec ? okCodes.has(Number(rec.response_code)) : false;
      return {
        accepted,
        providerMessageId: rec?.message_id ? String(rec.message_id) : undefined,
        error: accepted ? undefined : (rec?.response_status ?? 'TurboSMS: відхилено'),
      };
    } catch (e) {
      return {
        accepted: false,
        error: e instanceof Error ? e.message : 'TurboSMS: помилка мережі',
      };
    }
  }

  async verifyCredentials(creds: ProviderCredentials): Promise<VerifyResult> {
    try {
      // /user/balance.json — підтверджує валідність токена й повертає баланс. Тест-SMS не шлемо.
      const res = await this.fetchJson('/user/balance.json', { token: creds.apiKey });
      if (Number(res?.response_code) === 0 && res?.response_result != null) {
        const balance = Number(res.response_result?.balance ?? res.response_result);
        return { valid: true, balance: Number.isFinite(balance) ? balance : undefined };
      }
      return { valid: false, error: res?.response_status ?? 'Невірний токен' };
    } catch (e) {
      return { valid: false, error: e instanceof Error ? e.message : 'Помилка перевірки' };
    }
  }

  /** POST JSON із timeout. Кидає на non-2xx / abort. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async fetchJson(path: string, body: Record<string, unknown>): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${TURBOSMS_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`TurboSMS ${response.status}: ${err}`);
    }
    return response.json();
  }
}
