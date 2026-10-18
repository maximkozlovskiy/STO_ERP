/**
 * Типізовані помилки обміну з API постачальника (BR-SCON-005..008).
 *
 * Обробник черги вирішує за типом, а не за текстом:
 *  - `rateLimit` — відкласти задачу до скидання квоти без витрати спроби (BR-SCON-007);
 *  - `auth`, `protocol` — повтор не допоможе: `UnrecoverableError`, доменний рядок FAILED;
 *  - `network`, `server` — повторювані (attempts 10, експоненційний backoff, ADR-005).
 *
 * `ambiguous` — запит міг дійти до постачальника, а відповідь загубилась (тайм-аут, обрив, 5xx).
 * Для неповторюваного кроку замовлення (оформлення) це сигнал звірки за `reference`
 * (BR-SCON-011), а не повтору: інакше постачальник отримав би друге замовлення.
 *
 * Текст — «<провайдер> <статус>: <тіло>» без секретів (`redactSecrets` у клієнті):
 * IntegrationLogService дістає статус із тексту.
 */
export type SupplierErrorKind = 'auth' | 'rateLimit' | 'network' | 'server' | 'protocol';

export class SupplierApiError extends Error {
  constructor(
    readonly kind: SupplierErrorKind,
    readonly provider: string,
    message: string,
    readonly httpStatus: number | null,
    readonly retryable: boolean,
    readonly ambiguous: boolean,
  ) {
    super(message);
    this.name = 'SupplierApiError';
  }
}

export class SupplierAuthError extends SupplierApiError {
  constructor(provider: string, message: string, httpStatus: number | null = null) {
    super('auth', provider, message, httpStatus, false, false);
    this.name = 'SupplierAuthError';
  }
}

export class SupplierRateLimitError extends SupplierApiError {
  constructor(
    provider: string,
    message: string,
    readonly retryAfterMs: number,
    httpStatus: number | null = 429,
  ) {
    // Ліміт відхиляє запит ДО обробки — дублювання немає, тож не ambiguous.
    super('rateLimit', provider, message, httpStatus, true, false);
    this.name = 'SupplierRateLimitError';
  }
}

export class SupplierNetworkError extends SupplierApiError {
  constructor(provider: string, message: string, ambiguous: boolean) {
    super('network', provider, message, null, true, ambiguous);
    this.name = 'SupplierNetworkError';
  }
}

export class SupplierServerError extends SupplierApiError {
  constructor(provider: string, message: string, httpStatus: number) {
    super('server', provider, message, httpStatus, true, true);
    this.name = 'SupplierServerError';
  }
}

export class SupplierProtocolError extends SupplierApiError {
  constructor(
    provider: string,
    message: string,
    httpStatus: number | null = null,
    ambiguous = false,
  ) {
    super('protocol', provider, message, httpStatus, false, ambiguous);
    this.name = 'SupplierProtocolError';
  }
}

export function isSupplierError(e: unknown): e is SupplierApiError {
  return e instanceof SupplierApiError;
}

/** Межа тексту відповіді в повідомленні: досить для діагностики, без простирадла HTML. */
export const ERROR_BODY_MAX = 300;
