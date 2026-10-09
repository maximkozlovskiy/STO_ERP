import type { RawTx } from '../bank-reconciliation.service';

/** Креди + база API банку (per-branch, write-only, шифруються at-rest). */
export interface BankStatementConfig {
  apiUrl?: string | null;
  /** Секрети (розпарсений JSON з BranchProviderConfig.credentials): privat24 → { merchantId, token }. */
  credentials: Record<string, string>;
}

/** Параметри витягу виписки: рахунок (IBAN) + вікно дат [from, to]. */
export interface BankStatementFetchParams {
  iban: string;
  from: Date;
  to: Date;
}

export interface BankStatementVerifyResult {
  valid: boolean;
  error?: string;
}

/**
 * Абстракція банку-провайдера виписки (pull платежів ОБОХ напрямків за період). Дозволяє додавати банки
 * (Privat24 Merchant API, у майбутньому mono/Ощад) без зміни pull-процесора — той лише робить
 * `registry.get(code)`. Модель — polling за вікном дат (offline-first за NAT, без webhook).
 */
export interface BankStatementProvider {
  /** Унікальний код (зберігається у BranchProviderConfig.provider). */
  readonly code: string;
  /** Людська назва для UI. */
  readonly name: string;

  /**
   * Витягти транзакції за вікно дат → нормалізовані RawTx обох напрямків (BR-BANK-019).
   * Контракт рядка: `direction` заданий явно; `amount` > 0 (знак банку — у `direction`);
   * `payer*` — КОНТРАГЕНТ операції (платник для IN, отримувач для OUT), ніколи наш бік;
   * `operationDate` — київський календарний день операції як UTC-північ (BR-BANK-021).
   * Рядок із невідомим напрямом або нульовою сумою провайдер пропускає, а не вгадує.
   */
  fetchStatements(cfg: BankStatementConfig, params: BankStatementFetchParams): Promise<RawTx[]>;

  /** Перевірити креди (валідність id/token) — БЕЗ побічних ефектів. */
  verifyCredentials(cfg: BankStatementConfig): Promise<BankStatementVerifyResult>;
}

/**
 * DI-токен для мульти-провайдер реєстрації (Open/Closed + DIP). Кожна BankStatementProvider
 * реєструється у bank-statements.module через useFactory-масив (NestJS 10, без Angular multi:true),
 * а BankProviderRegistry інжектить `BankStatementProvider[]`.
 */
export const BANK_STATEMENT_PROVIDERS = Symbol('BANK_STATEMENT_PROVIDERS');
