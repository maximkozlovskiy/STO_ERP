import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { validatePublicUrl } from '../../../common/utils/url-guard';
import type {
  PaymentGateway,
  GatewayConfig,
  CreateInvoiceParams,
  CreateInvoiceResult,
  GatewayStatusResult,
  GatewayVerifyResult,
  GatewayStatus,
} from './payment-gateway.interface';

const DEFAULT_BASE = 'https://www.liqpay.ua';
const API_VERSION = 3;
const HTTP_TIMEOUT_MS = 10_000;

/**
 * Шлюз LiqPay (ПриватБанк). Протокол: пара `data`+`signature`, де
 * data = base64(JSON), signature = base64(SHA1(privateKey + data + privateKey)).
 * checkoutUrl = GET-сторінка `/api/{v}/checkout?data=..&signature=..` → рендериться як QR
 * (клієнт сканує й платить на стороні LiqPay). Статус — POST `/api/request` action=status
 * (той самий data+signature механізм). Точний shape полів звірити на реальному merchant-акаунті —
 * цей клас ізолює будь-які зміни від решти коду (як monobank.client / checkbox.client).
 *
 * SSRF-guard + AbortController timeout + reject-3xx на статус-виклику.
 */
@Injectable()
export class LiqpayGateway implements PaymentGateway {
  readonly code = 'liqpay';
  readonly name = 'LiqPay (ПриватБанк)';

  private creds(cfg: GatewayConfig): { publicKey: string; privateKey: string } {
    const publicKey = cfg.credentials?.publicKey;
    const privateKey = cfg.credentials?.privateKey;
    if (!publicKey || !privateKey) throw new Error('LiqPay: не задано public/private ключ');
    return { publicKey, privateKey };
  }

  /** data = base64(JSON), signature = base64(SHA1(private + data + private)). */
  private sign(
    privateKey: string,
    payload: Record<string, unknown>,
  ): { data: string; signature: string } {
    const data = Buffer.from(JSON.stringify(payload)).toString('base64');
    const signature = createHash('sha1')
      .update(privateKey + data + privateKey)
      .digest('base64');
    return { data, signature };
  }

  async createInvoice(
    cfg: GatewayConfig,
    params: CreateInvoiceParams,
  ): Promise<CreateInvoiceResult> {
    const { publicKey, privateKey } = this.creds(cfg);
    const base = (cfg.apiUrl || DEFAULT_BASE).replace(/\/$/, '');
    const urlError = validatePublicUrl(base);
    if (urlError) throw new Error(`Невалідний LiqPay API URL: ${urlError}`);

    const { data, signature } = this.sign(privateKey, {
      public_key: publicKey,
      version: API_VERSION,
      action: 'pay',
      amount: (params.amountCents / 100).toFixed(2),
      currency: 'UAH',
      description: params.description ?? 'Оплата за послуги автосервісу',
      order_id: params.reference,
    });

    // Checkout = GET-сторінка LiqPay з data+signature у query. Рендериться клієнтом як QR;
    // сам рахунок «створюється» при першому переході — тому gatewayInvoiceId = наш order_id
    // (reference), за яким потім опитуємо статус.
    const checkoutUrl =
      `${base}/api/${API_VERSION}/checkout?data=${encodeURIComponent(data)}` +
      `&signature=${encodeURIComponent(signature)}`;
    return { gatewayInvoiceId: params.reference, checkoutUrl };
  }

  async getStatus(cfg: GatewayConfig, gatewayInvoiceId: string): Promise<GatewayStatusResult> {
    const { publicKey, privateKey } = this.creds(cfg);
    const res = await this.request(cfg.apiUrl, privateKey, {
      public_key: publicKey,
      version: API_VERSION,
      action: 'status',
      order_id: gatewayInvoiceId,
    });
    const raw = String(res?.status ?? 'unknown');
    return { status: this.mapStatus(raw), raw };
  }

  private mapStatus(s: string): GatewayStatus {
    switch (s) {
      case 'success':
      case 'wait_compensation': // кошти списано, чекає компенсації мерчанту — вважаємо оплаченим
      case 'subscribed':
        return 'paid';
      case 'failure':
      case 'error':
      case 'reversed':
        return 'failed';
      case 'expired':
        return 'expired';
      // 'wait_accept' / 'processing' / 'prepared' / '3ds_verify' / 'wait_secure' → ще триває
      default:
        return 'pending';
    }
  }

  async verifyCredentials(cfg: GatewayConfig): Promise<GatewayVerifyResult> {
    try {
      const { publicKey, privateKey } = this.creds(cfg);
      // status на синтетичний order_id: валідні ключі → відповідь (error «payment not found»),
      // невалідні public/private → err_code invalid_signature / public_key.
      const res = await this.request(cfg.apiUrl, privateKey, {
        public_key: publicKey,
        version: API_VERSION,
        action: 'status',
        order_id: 'verify-' + Date.now(),
      });
      const errCode = String(res?.err_code ?? res?.code ?? '');
      if (/signature|public_key|wrong_?key|invalid/i.test(errCode)) {
        return { valid: false, error: 'Невірні ключі LiqPay' };
      }
      return { valid: true };
    } catch (e) {
      return { valid: false, error: e instanceof Error ? e.message : 'Помилка перевірки' };
    }
  }

  /** POST /api/request з data+signature. SSRF-guard + redirect:'manual' + timeout + reject-3xx. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(
    apiUrlRaw: string | null | undefined,
    privateKey: string,
    payload: Record<string, unknown>,
  ): Promise<any> {
    const base = (apiUrlRaw || DEFAULT_BASE).replace(/\/$/, '');
    const urlError = validatePublicUrl(base);
    if (urlError) throw new Error(`Невалідний LiqPay API URL: ${urlError}`);

    const { data, signature } = this.sign(privateKey, payload);
    const body = new URLSearchParams({ data, signature }).toString();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${base}/api/request`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new Error(`LiqPay повернув перенаправлення ${response.status} — запит відхилено`);
    }
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`LiqPay ${response.status}: ${err}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
}
