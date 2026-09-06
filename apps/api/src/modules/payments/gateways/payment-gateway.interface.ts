/** Наш нормалізований статус наміру (мапиться зі статусу gateway). */
export type GatewayStatus = 'pending' | 'paid' | 'failed' | 'expired';

/** Креди + база API конкретного шлюзу (per-branch, write-only, шифруються at-rest). */
export interface GatewayConfig {
  apiUrl?: string | null;
  /**
   * Секрети шлюзу (розпарсений JSON з BranchProviderConfig.credentials):
   * monobank → { token }; liqpay → { publicKey, privateKey }.
   */
  credentials: Record<string, string>;
}

export interface CreateInvoiceParams {
  /** Сума у копійках (cents). */
  amountCents: number;
  /** Наш стабільний reference (id наміру) — для звірки. */
  reference: string;
  /** Призначення платежу (опис для клієнта). */
  description?: string;
}

export interface CreateInvoiceResult {
  /** Id рахунку у шлюзі (для подальшого опитування статусу). */
  gatewayInvoiceId: string;
  /** Сторінка оплати шлюзу — рендериться як QR (клієнт сканує й платить там). */
  checkoutUrl: string;
}

export interface GatewayStatusResult {
  status: GatewayStatus;
  /** Сирий статус шлюзу (для логів/діагностики). */
  raw: string;
}

export interface GatewayVerifyResult {
  valid: boolean;
  error?: string;
}

/**
 * Абстракція платіжного шлюзу (еквайринг). Дозволяє додавати шлюзи без зміни
 * online-payment.service / payment-polling.processor — ті лише роблять `registry.get(code)`.
 * QR-на-екрані (checkoutUrl) → клієнт платить на стороні шлюзу, ми лише опитуємо статус
 * (polling) → жодного webhook/публічного endpoint (offline-first за NAT).
 */
export interface PaymentGateway {
  /** Унікальний код (зберігається у OnlinePaymentIntent.gateway / BranchProviderConfig.provider). */
  readonly code: string;
  /** Людська назва для UI. */
  readonly name: string;

  /** Створити рахунок на оплату → checkoutUrl (QR). */
  createInvoice(cfg: GatewayConfig, params: CreateInvoiceParams): Promise<CreateInvoiceResult>;

  /** Опитати статус рахунку → нормалізований статус. */
  getStatus(cfg: GatewayConfig, gatewayInvoiceId: string): Promise<GatewayStatusResult>;

  /** Перевірити креди (валідність) — БЕЗ створення реального рахунку. */
  verifyCredentials(cfg: GatewayConfig): Promise<GatewayVerifyResult>;
}
