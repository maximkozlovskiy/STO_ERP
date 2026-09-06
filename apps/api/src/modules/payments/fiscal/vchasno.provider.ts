import { Injectable } from '@nestjs/common';
import { validatePublicUrl } from '../../../common/utils/url-guard';
import {
  FiscalProvider,
  FiscalConfig,
  FiscalToken,
  FiscalVerifyResult,
  FiscalUnauthorizedError,
  SellReceiptParams,
} from './fiscal-provider.interface';

const DEFAULT_BASE = 'https://kasa.vchasno.ua';
const SYNC_TIMEOUT_MS = 10_000;
const SELL_TIMEOUT_MS = 15_000;

/**
 * Провайдер ПРРО «Вчасно.Каса» (EDIN). Auth: API-токен (Bearer) — sign-in лише повертає токен
 * з кредів (окремого PIN-обміну немає, на відміну від Checkbox). Керування зміною + чек продажу.
 * Точний shape endpoint-ів звірити на реальному акаунті — цей клас ізолює будь-які зміни від
 * решти коду (як checkbox.client / monobank.client). SSRF-guard + redirect:'manual' + timeout +
 * reject-3xx + 401→FiscalUnauthorizedError.
 */
@Injectable()
export class VchasnoProvider implements FiscalProvider {
  readonly code = 'vchasno';
  readonly name = 'Вчасно.Каса';

  private apiUrl(cfg: FiscalConfig): string {
    return cfg.apiUrl || DEFAULT_BASE;
  }

  private token(cfg: FiscalConfig): string {
    const t = cfg.credentials?.token;
    if (!t) throw new Error('Вчасно: не задано API-токен');
    return t;
  }

  /** Вчасно використовує токен напряму — sign-in лише повертає його (без окремого обміну). */
  async signIn(cfg: FiscalConfig): Promise<FiscalToken> {
    // Токен довготривалий (керується у кабінеті Вчасно) — expiresAt не задаємо, клієнт-код
    // виставить дефолтний TTL. Реальної валідації тут немає (робиться у verifyCredentials).
    return { accessToken: this.token(cfg) };
  }

  async openShift(cfg: FiscalConfig, accessToken: string): Promise<{ providerShiftId: string }> {
    const res = await this.call(
      'POST',
      cfg,
      '/api/v1/shifts/open',
      SYNC_TIMEOUT_MS,
      accessToken,
      {},
    );
    const id = res?.id ?? res?.shift_id;
    if (!id) throw new Error('Вчасно: не отримано id зміни');
    return { providerShiftId: String(id) };
  }

  async closeShift(cfg: FiscalConfig, accessToken: string): Promise<{ zReportId?: string }> {
    const res = await this.call(
      'POST',
      cfg,
      '/api/v1/shifts/close',
      SYNC_TIMEOUT_MS,
      accessToken,
      {},
    );
    return {
      zReportId: res?.z_report_id ? String(res.z_report_id) : res?.id ? String(res.id) : undefined,
    };
  }

  async sellReceipt(
    cfg: FiscalConfig,
    accessToken: string,
    params: SellReceiptParams,
  ): Promise<{ fiscalReceiptId: string }> {
    const cents = Math.round(params.amount * 100);
    const res = await this.call(
      'POST',
      cfg,
      '/api/v1/receipts/sell',
      SELL_TIMEOUT_MS,
      accessToken,
      {
        goods: [{ name: params.goodName ?? 'Послуги автосервісу', price: cents, quantity: 1 }],
        payment: { type: params.method === 'cash' ? 'CASH' : 'CASHLESS', value: cents },
      },
    );
    const id = res?.id ?? res?.fiscal_code ?? res?.receipt_id;
    if (!id) throw new Error('Вчасно: не отримано id чеку');
    return { fiscalReceiptId: String(id) };
  }

  async verifyCredentials(cfg: FiscalConfig): Promise<FiscalVerifyResult> {
    try {
      // Валідність токена: запит статусу каси/акаунта (без побічних ефектів).
      const res = await this.call(
        'GET',
        cfg,
        '/api/v1/cash-registers',
        SYNC_TIMEOUT_MS,
        this.token(cfg),
      );
      const name = Array.isArray(res) ? res[0]?.name : res?.name;
      return { valid: true, cashRegisterName: name ? String(name) : undefined };
    } catch (e) {
      if (e instanceof FiscalUnauthorizedError)
        return { valid: false, error: 'Невірний API-токен' };
      return { valid: false, error: e instanceof Error ? e.message : 'Помилка перевірки' };
    }
  }

  /** SSRF-guard + redirect:'manual' + timeout + reject-3xx + 401-mapping (Bearer=token). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async call(
    method: 'GET' | 'POST',
    cfg: FiscalConfig,
    path: string,
    timeoutMs: number,
    accessToken: string,
    body?: unknown,
  ): Promise<any> {
    const apiUrl = this.apiUrl(cfg).replace(/\/$/, '');
    const urlError = validatePublicUrl(apiUrl);
    if (urlError) throw new Error(`Невалідний Вчасно API URL: ${urlError}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${apiUrl}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      throw new Error(`Вчасно повернув перенаправлення ${response.status} — запит відхилено`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new FiscalUnauthorizedError('Вчасно: неавторизовано (токен недійсний?)');
    }
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Вчасно ${response.status}: ${err}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
}
