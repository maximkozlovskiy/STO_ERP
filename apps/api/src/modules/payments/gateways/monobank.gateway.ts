import { Injectable } from '@nestjs/common';
import { MonobankClient } from '../monobank.client';
import type {
  PaymentGateway,
  GatewayConfig,
  CreateInvoiceParams,
  CreateInvoiceResult,
  GatewayStatusResult,
  GatewayVerifyResult,
} from './payment-gateway.interface';

/**
 * Шлюз monobank Acquiring. Обгортка наявного MonobankClient під інтерфейс PaymentGateway
 * (registry). Auth: X-Token merchant. Поведінка ідентична доти-хардкодженому виклику —
 * лише резолвиться через registry.get('monobank').
 */
@Injectable()
export class MonobankGateway implements PaymentGateway {
  readonly code = 'monobank';
  readonly name = 'monobank Еквайринг';

  constructor(private readonly client: MonobankClient) {}

  private token(cfg: GatewayConfig): string {
    const t = cfg.credentials?.token;
    if (!t) throw new Error('monobank: не задано X-Token');
    return t;
  }

  async createInvoice(
    cfg: GatewayConfig,
    params: CreateInvoiceParams,
  ): Promise<CreateInvoiceResult> {
    const { gatewayInvoiceId, pageUrl } = await this.client.createInvoice(
      cfg.apiUrl,
      this.token(cfg),
      {
        amountCents: params.amountCents,
        reference: params.reference,
      },
    );
    return { gatewayInvoiceId, checkoutUrl: pageUrl };
  }

  async getStatus(cfg: GatewayConfig, gatewayInvoiceId: string): Promise<GatewayStatusResult> {
    return this.client.getStatus(cfg.apiUrl, this.token(cfg), gatewayInvoiceId);
  }

  /** Верифікація без побічних ефектів: статус завідомо-неіснуючого рахунку — валідний токен → 404,
   * невалідний → 401/403. Ми лише перевіряємо, що клієнт не кинув auth-помилку до відповіді. */
  async verifyCredentials(cfg: GatewayConfig): Promise<GatewayVerifyResult> {
    try {
      // Пробний виклик status на синтетичний reference; будь-яка відповідь (навіть 404 «не знайдено»)
      // означає, що токен прийнято. Auth-помилка (401/403) → невалідні креди.
      await this.client.getStatus(cfg.apiUrl, this.token(cfg), 'verify-' + Date.now());
      return { valid: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Помилка';
      // 4xx «не знайдено рахунок» ⇒ токен валідний; 401/403 ⇒ ні.
      if (/401|403|unauthor|forbidden/i.test(msg))
        return { valid: false, error: 'Невірний X-Token' };
      // Інші помилки (404/timeout) вважаємо валідним токеном (рахунок просто не існує).
      if (/40[04]/.test(msg)) return { valid: true };
      return { valid: false, error: msg };
    }
  }
}
