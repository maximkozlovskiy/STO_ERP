import { Injectable, Logger } from '@nestjs/common';
import { validatePublicUrl } from '../../common/utils/url-guard';

const DEFAULT_BASE = 'https://api.checkbox.ua';
const SYNC_TIMEOUT_MS = 10_000; // sign-in / shift open/close (інтерактивні)
const SELL_TIMEOUT_MS = 15_000; // sell (у черзі, offline-first)

export interface CashierToken {
  accessToken: string;
  /** ISO expiry, якщо API повертає; інакше undefined (клієнт-код виставить дефолт). */
  expiresAt?: string;
}

export interface SellReceiptResult {
  fiscalReceiptId: string;
}

/**
 * Тонкий клієнт Checkbox ПРРО. Інкапсулює автентифікацію (cashier sign-in по PIN → access-token),
 * керування зміною (open/close) та пробиття чеку. Кожен виклик: validatePublicUrl (SSRF) +
 * redirect:'manual' + AbortController timeout + reject-3xx. Точний shape endpoint-ів уточнюється
 * на реальному акаунті — цей клас ізолює будь-які зміни від решти коду.
 *
 * Errors: 401 → кидаємо HttpUnauthorizedError (щоб processor міг re-sign-in); решта → Error.
 */
export class CheckboxUnauthorizedError extends Error {}

@Injectable()
export class CheckboxClient {
  private readonly logger = new Logger(CheckboxClient.name);

  /** Вхід касира за PIN → access-token. Bearer = license key. */
  async signInPinCode(apiUrl: string, licenseKey: string, pinCode: string): Promise<CashierToken> {
    const res = await this.call('POST', apiUrl, '/api/v1/cashier/signinPinCode', SYNC_TIMEOUT_MS, {
      headers: { 'X-License-Key': licenseKey },
      body: { pin_code: pinCode },
    });
    const token = res?.access_token ?? res?.token;
    if (!token) throw new Error('Checkbox: не отримано access-token');
    return { accessToken: String(token), expiresAt: res?.expires_at ?? undefined };
  }

  /** Відкрити зміну (Bearer = access-token). → checkboxShiftId. */
  async openShift(apiUrl: string, accessToken: string): Promise<{ checkboxShiftId: string }> {
    const res = await this.call('POST', apiUrl, '/api/v1/shifts', SYNC_TIMEOUT_MS, {
      accessToken,
      body: {},
    });
    const id = res?.id;
    if (!id) throw new Error('Checkbox: не отримано id зміни');
    return { checkboxShiftId: String(id) };
  }

  /** Закрити зміну (Z-звіт). → zReportId (якщо повертається). */
  async closeShift(apiUrl: string, accessToken: string): Promise<{ zReportId?: string }> {
    const res = await this.call('POST', apiUrl, '/api/v1/shifts/close', SYNC_TIMEOUT_MS, {
      accessToken,
      body: {},
    });
    return {
      zReportId: res?.z_report?.id ? String(res.z_report.id) : res?.id ? String(res.id) : undefined,
    };
  }

  /** Пробити чек продажу у відкриту зміну (Bearer = access-token). */
  async sellReceipt(
    apiUrl: string,
    accessToken: string,
    params: { amount: number; method: string; goodName?: string },
  ): Promise<SellReceiptResult> {
    const cents = Math.round(params.amount * 100);
    const res = await this.call('POST', apiUrl, '/api/v1/receipts/sell', SELL_TIMEOUT_MS, {
      accessToken,
      body: {
        goods: [
          {
            good: { name: params.goodName ?? 'Послуги автосервісу', price: cents },
            quantity: 1000, // Checkbox: milli-units → 1.000
          },
        ],
        payments: [{ type: params.method === 'cash' ? 'CASH' : 'CASHLESS', value: cents }],
      },
    });
    const id = res?.id ?? res?.fiscal_code;
    if (!id) throw new Error('Checkbox: не отримано id чеку');
    return { fiscalReceiptId: String(id) };
  }

  /**
   * Спільний HTTP-виклик: SSRF-guard + redirect:'manual' + timeout + reject-3xx + 401-mapping.
   * accessToken → Bearer; або headers для sign-in (X-License-Key).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async call(
    method: 'POST',
    apiUrlRaw: string | null | undefined,
    path: string,
    timeoutMs: number,
    opts: { accessToken?: string; headers?: Record<string, string>; body?: unknown },
  ): Promise<any> {
    const apiUrl = apiUrlRaw || DEFAULT_BASE;
    const urlError = validatePublicUrl(apiUrl);
    if (urlError) throw new Error(`Невалідний Checkbox API URL: ${urlError}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${apiUrl}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          ...(opts.accessToken ? { Authorization: `Bearer ${opts.accessToken}` } : {}),
          ...(opts.headers ?? {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // 3xx під redirect:'manual' → підозра на SSRF-tampering.
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`Checkbox повернув перенаправлення ${response.status} — запит відхилено`);
    }
    if (response.status === 401) {
      throw new CheckboxUnauthorizedError('Checkbox: неавторизовано (токен протух?)');
    }
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Checkbox ${response.status}: ${err}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
}
