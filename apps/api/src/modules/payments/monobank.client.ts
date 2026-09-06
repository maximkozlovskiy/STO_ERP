import { Injectable, Logger } from '@nestjs/common';
import { validatePublicUrl } from '../../common/utils/url-guard';

const DEFAULT_BASE = 'https://api.monobank.ua';
const HTTP_TIMEOUT_MS = 10_000;

/** Наш нормалізований статус наміру (мапиться з monobank invoice.status). */
export type MonoInvoiceStatus = 'pending' | 'paid' | 'failed' | 'expired';

export interface CreateInvoiceResult {
  gatewayInvoiceId: string;
  pageUrl: string;
}

/**
 * Клієнт monobank Acquiring (еквайринг). Тонкий HTTP: invoice/create + invoice/status.
 * Auth: X-Token merchant. QR = pageUrl (сторінка monobank) → клієнт сканує й платить там,
 * ми лише опитуємо статус (polling) → жодного webhook/публічного endpoint (offline-first, за NAT).
 * SSRF-guard + AbortController timeout + reject-3xx (як checkbox.client).
 */
@Injectable()
export class MonobankClient {
  private readonly logger = new Logger(MonobankClient.name);

  /** Створити рахунок на оплату. amount — у копійках (cents). ccy 980 = UAH. */
  async createInvoice(
    apiUrl: string | null | undefined,
    token: string,
    params: { amountCents: number; reference: string; ccy?: number },
  ): Promise<CreateInvoiceResult> {
    const res = await this.call('POST', apiUrl, '/api/merchant/invoice/create', token, {
      amount: params.amountCents,
      ccy: params.ccy ?? 980,
      merchantPaymInfo: {
        reference: params.reference,
        destination: 'Оплата за послуги автосервісу',
      },
    });
    if (!res?.invoiceId || !res?.pageUrl) {
      throw new Error('monobank: не отримано invoiceId/pageUrl');
    }
    return { gatewayInvoiceId: String(res.invoiceId), pageUrl: String(res.pageUrl) };
  }

  /** Статус рахунку. Мапимо monobank-статус у наш нормалізований. */
  async getStatus(
    apiUrl: string | null | undefined,
    token: string,
    gatewayInvoiceId: string,
  ): Promise<{ status: MonoInvoiceStatus; raw: string }> {
    const res = await this.call(
      'GET',
      apiUrl,
      `/api/merchant/invoice/status?invoiceId=${encodeURIComponent(gatewayInvoiceId)}`,
      token,
    );
    const raw = String(res?.status ?? 'unknown');
    return { status: this.mapStatus(raw), raw };
  }

  private mapStatus(mono: string): MonoInvoiceStatus {
    switch (mono) {
      case 'success':
        return 'paid';
      case 'failure':
      case 'reversed':
        return 'failed';
      case 'expired':
        return 'expired';
      // created / processing / hold → ще триває
      default:
        return 'pending';
    }
  }

  /** SSRF-guard + redirect:'manual' + timeout + reject-3xx. X-Token header. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async call(
    method: 'GET' | 'POST',
    apiUrlRaw: string | null | undefined,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<any> {
    const apiUrl = apiUrlRaw || DEFAULT_BASE;
    const urlError = validatePublicUrl(apiUrl);
    if (urlError) throw new Error(`Невалідний monobank API URL: ${urlError}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${apiUrl}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          'X-Token': token,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new Error(`monobank повернув перенаправлення ${response.status} — запит відхилено`);
    }
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`monobank ${response.status}: ${err}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
}
