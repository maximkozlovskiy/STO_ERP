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

// Єдиний dispatcher-endpoint Вчасно.Каса Cloud API v3 — операція обирається кодом `task`
// у тілі `{ fiscal: { task, ... } }` (звірено з офіц. wiki-kasa.vchasno.ua/uk/cloud/CloudAPI
// + публічною Postman-колекцією). НЕ REST-per-operation (наш попередній v1 shape був хибний).
const FISCAL_EXECUTE = '/api/v3/fiscal/execute';
const TASK = {
  OPEN_SHIFT: 0,
  SELL: 1,
  CLOSE_SHIFT: 11,
  STATUS: 18,
} as const;

/**
 * Провайдер ПРРО «Вчасно.Каса» (EDIN). Cloud API v3: усі фіскальні операції — один
 * POST /api/v3/fiscal/execute з `task`-кодом (0=відкрити зміну, 1=чек, 11=Z-звіт, 18=статус).
 *
 * Auth: токен каси у заголовку `Authorization` **БЕЗ префікса `Bearer`** (офіц. вимога Вчасно,
 * на відміну від Checkbox). Токен генерується per-каса у кабінеті (Торгові точки та каси →
 * каса → Налаштування → Токен). Sign-in лише повертає токен з кредів (окремого обміну немає).
 *
 * ⚠️ ВЕРИФІКАЦІЯ НА ЖИВОМУ АКАУНТІ: транспорт/версія/task-dispatch/auth-заголовок звірені з
 * докою. Точні ІМЕНА ПОЛІВ у payload чека продажу (task:1) та у відповідях (id зміни/чека)
 * фіналізувати на реальній тест-касі Вчасно — цей клас ізолює будь-які зміни від решти коду.
 * SSRF-guard + redirect:'manual' + timeout + reject-3xx + 401→FiscalUnauthorizedError.
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
  // eslint-disable-next-line @typescript-eslint/require-await -- async за FiscalProvider-інтерфейсом (інші провайдери роблять мережевий sign-in)
  async signIn(cfg: FiscalConfig): Promise<FiscalToken> {
    // Токен довготривалий (керується у кабінеті Вчасно) — expiresAt не задаємо, клієнт-код
    // виставить дефолтний TTL. Реальна валідація — у verifyCredentials.
    return { accessToken: this.token(cfg) };
  }

  async openShift(cfg: FiscalConfig, accessToken: string): Promise<{ providerShiftId: string }> {
    const res = await this.execute(cfg, SYNC_TIMEOUT_MS, accessToken, { task: TASK.OPEN_SHIFT });
    const id = this.extractId(res, ['shift_id', 'shiftId', 'id', 'fisn', 'fiscal_number']);
    if (!id) throw new Error('Вчасно: не отримано id зміни');
    return { providerShiftId: id };
  }

  async closeShift(cfg: FiscalConfig, accessToken: string): Promise<{ zReportId?: string }> {
    const res = await this.execute(cfg, SYNC_TIMEOUT_MS, accessToken, { task: TASK.CLOSE_SHIFT });
    const id = this.extractId(res, ['z_report_id', 'zReportId', 'report_id', 'id', 'fisn']);
    return { zReportId: id };
  }

  async sellReceipt(
    cfg: FiscalConfig,
    accessToken: string,
    params: SellReceiptParams,
  ): Promise<{ fiscalReceiptId: string }> {
    const cents = Math.round(params.amount * 100);
    // Чек продажу (task:1): один рядок-послуга + оплата. Суми — у копійках (int).
    // Поля goods/payment та enum типу оплати — best-guess за докою; фіналізувати на живій касі.
    const res = await this.execute(cfg, SELL_TIMEOUT_MS, accessToken, {
      task: TASK.SELL,
      goods: [{ name: params.goodName ?? 'Послуги автосервісу', price: cents, quantity: 1 }],
      payment: { type: params.method === 'cash' ? 'CASH' : 'CASHLESS', value: cents },
    });
    const id = this.extractId(res, ['fisn', 'fiscal_number', 'fiscal_code', 'receipt_id', 'id']);
    if (!id) throw new Error('Вчасно: не отримано id чеку');
    return { fiscalReceiptId: id };
  }

  async verifyCredentials(cfg: FiscalConfig): Promise<FiscalVerifyResult> {
    try {
      // Валідність токена: статус каси (task:18) — без побічних ефектів. Валідний токен → 200;
      // невалідний → 401/403 → FiscalUnauthorizedError.
      const res = await this.execute(cfg, SYNC_TIMEOUT_MS, this.token(cfg), { task: TASK.STATUS });
      const name =
        (res?.cash_register as { name?: string } | undefined)?.name ??
        res?.name ??
        res?.cashRegisterName;
      return { valid: true, cashRegisterName: name ? String(name) : undefined };
    } catch (e) {
      if (e instanceof FiscalUnauthorizedError)
        return { valid: false, error: 'Невірний API-токен' };
      return { valid: false, error: e instanceof Error ? e.message : 'Помилка перевірки' };
    }
  }

  /** Перший наявний рядковий id зі списку кандидат-ключів (shape відповіді ще фіналізується). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractId(res: any, keys: string[]): string | undefined {
    const fiscal = res?.fiscal ?? res; // відповідь може бути обгорнута у { fiscal: {...} }
    for (const k of keys) {
      const v = fiscal?.[k] ?? res?.[k];
      if (v !== undefined && v !== null && v !== '') return String(v);
    }
    return undefined;
  }

  /**
   * Виклик dispatcher-а: POST /api/v3/fiscal/execute з `{ fiscal: {...} }`.
   * Auth: `Authorization: <token>` БЕЗ `Bearer`. SSRF-guard + manual-redirect + timeout +
   * reject-3xx + 401→FiscalUnauthorizedError.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async execute(
    cfg: FiscalConfig,
    timeoutMs: number,
    accessToken: string,
    fiscal: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- зовнішній API-response (валідація/narrow нижче за викликом)
  ): Promise<any> {
    const apiUrl = this.apiUrl(cfg).replace(/\/$/, '');
    const urlError = validatePublicUrl(apiUrl);
    if (urlError) throw new Error(`Невалідний Вчасно API URL: ${urlError}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${apiUrl}${FISCAL_EXECUTE}`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          // Вчасно: сирий токен БЕЗ префікса Bearer (офіц. вимога).
          Authorization: accessToken,
        },
        body: JSON.stringify({ fiscal }),
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
