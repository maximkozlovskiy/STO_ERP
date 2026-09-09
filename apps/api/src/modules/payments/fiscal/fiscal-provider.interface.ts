/**
 * Помилка авторизації провайдера ПРРО (токен протух). Провайдер-агностична — processor
 * ловить її для одноразового re-sign-in (замість специфічного CheckboxUnauthorizedError).
 */
export class FiscalUnauthorizedError extends Error {}

/** Креди + база API провайдера ПРРО (per-branch, write-only, шифруються at-rest). */
export interface FiscalConfig {
  apiUrl?: string | null;
  /**
   * Секрети провайдера (розпарсений JSON з BranchProviderConfig.credentials):
   * checkbox → { licenseKey, pinCode, cashRegisterId? }; vchasno → { token, cashRegisterId? }.
   */
  credentials: Record<string, string>;
}

export interface FiscalToken {
  accessToken: string;
  /** ISO expiry, якщо API повертає; інакше undefined (клієнт-код виставить дефолт). */
  expiresAt?: string;
}

export interface SellReceiptParams {
  amount: number;
  method: string;
  goodName?: string;
}

export interface FiscalVerifyResult {
  valid: boolean;
  cashRegisterName?: string;
  error?: string;
}

/**
 * Абстракція провайдера ПРРО (фіскалізація). Дозволяє додавати провайдерів без зміни
 * cash-shift.service / fiscal.processor — ті лише роблять `registry.get(code)`.
 *
 * Життєвий цикл: signIn (креди→access-token) → openShift → sellReceipt* → closeShift (Z-звіт).
 * Токен зберігається на CashShift-рядку (шифрується). 401 → FiscalUnauthorizedError → re-sign-in.
 */
export interface FiscalProvider {
  /** Унікальний код (зберігається у BranchProviderConfig.provider / CashShift.provider). */
  readonly code: string;
  /** Людська назва для UI. */
  readonly name: string;

  /** Автентифікація → access-token. Checkbox: PIN→token; Вчасно: перевірка token. */
  signIn(cfg: FiscalConfig): Promise<FiscalToken>;

  /** Відкрити зміну (Bearer=access-token) → id зміни у провайдера. */
  openShift(cfg: FiscalConfig, accessToken: string): Promise<{ providerShiftId: string }>;

  /** Закрити зміну (Z-звіт) → id звіту (якщо повертається). */
  closeShift(cfg: FiscalConfig, accessToken: string): Promise<{ zReportId?: string }>;

  /** Пробити чек продажу у відкриту зміну → fiscalReceiptId. */
  sellReceipt(
    cfg: FiscalConfig,
    accessToken: string,
    params: SellReceiptParams,
  ): Promise<{ fiscalReceiptId: string }>;

  /** Перевірити креди (валідність) — БЕЗ пробиття чеку. */
  verifyCredentials(cfg: FiscalConfig): Promise<FiscalVerifyResult>;
}

/**
 * DI-токен для мульти-провайдер реєстрації (Open/Closed + DIP). Кожен FiscalProvider реєструється у
 * payments.module як `{ provide: FISCAL_PROVIDERS, useExisting: <Impl>, multi: true }`, а
 * FiscalProviderRegistry інжектить масив `FiscalProvider[]` — додавання нового провайдера більше НЕ
 * потребує зміни самого реєстру (лише +провайдер-клас і один рядок у модулі).
 */
export const FISCAL_PROVIDERS = Symbol('FISCAL_PROVIDERS');
