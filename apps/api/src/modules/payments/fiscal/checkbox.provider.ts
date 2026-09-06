import { Injectable } from '@nestjs/common';
import { CheckboxClient, CheckboxUnauthorizedError } from '../checkbox.client';
import {
  FiscalProvider,
  FiscalConfig,
  FiscalToken,
  FiscalVerifyResult,
  FiscalUnauthorizedError,
  SellReceiptParams,
} from './fiscal-provider.interface';

/**
 * Провайдер ПРРО Checkbox. Обгортка наявного CheckboxClient під інтерфейс FiscalProvider
 * (registry). Auth: PIN sign-in (Bearer=license key) → access-token. 401 → FiscalUnauthorizedError.
 * Поведінка ідентична доти-хардкодженому виклику — лише резолвиться через registry.get('checkbox').
 */
@Injectable()
export class CheckboxProvider implements FiscalProvider {
  readonly code = 'checkbox';
  readonly name = 'Checkbox';

  constructor(private readonly client: CheckboxClient) {}

  private apiUrl(cfg: FiscalConfig): string {
    return cfg.apiUrl || 'https://api.checkbox.ua';
  }

  private creds(cfg: FiscalConfig): { licenseKey: string; pinCode: string } {
    const licenseKey = cfg.credentials?.licenseKey;
    const pinCode = cfg.credentials?.pinCode;
    if (!licenseKey || !pinCode) throw new Error('Checkbox: не задано ключ/PIN');
    return { licenseKey, pinCode };
  }

  async signIn(cfg: FiscalConfig): Promise<FiscalToken> {
    const { licenseKey, pinCode } = this.creds(cfg);
    return this.wrap(() => this.client.signInPinCode(this.apiUrl(cfg), licenseKey, pinCode));
  }

  async openShift(cfg: FiscalConfig, accessToken: string): Promise<{ providerShiftId: string }> {
    const { checkboxShiftId } = await this.wrap(() =>
      this.client.openShift(this.apiUrl(cfg), accessToken),
    );
    return { providerShiftId: checkboxShiftId };
  }

  async closeShift(cfg: FiscalConfig, accessToken: string): Promise<{ zReportId?: string }> {
    return this.wrap(() => this.client.closeShift(this.apiUrl(cfg), accessToken));
  }

  async sellReceipt(
    cfg: FiscalConfig,
    accessToken: string,
    params: SellReceiptParams,
  ): Promise<{ fiscalReceiptId: string }> {
    return this.wrap(() => this.client.sellReceipt(this.apiUrl(cfg), accessToken, params));
  }

  async verifyCredentials(cfg: FiscalConfig): Promise<FiscalVerifyResult> {
    try {
      // Валідність = успішний PIN sign-in (без пробиття чеку).
      await this.signIn(cfg);
      return { valid: true };
    } catch (e) {
      if (e instanceof FiscalUnauthorizedError) return { valid: false, error: 'Невірний ключ/PIN' };
      return { valid: false, error: e instanceof Error ? e.message : 'Помилка перевірки' };
    }
  }

  /** Мапить CheckboxUnauthorizedError → провайдер-агностичний FiscalUnauthorizedError. */
  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof CheckboxUnauthorizedError) throw new FiscalUnauthorizedError(e.message);
      throw e;
    }
  }
}
