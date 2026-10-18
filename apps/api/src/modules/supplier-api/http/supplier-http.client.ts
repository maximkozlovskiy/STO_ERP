import { Injectable } from '@nestjs/common';
import { redactSecrets } from '../../../common/utils/redact';
import { SupplierUrlPolicy } from './supplier-url-policy';
import { DEFAULT_RATE_LIMIT_PAUSE_MS, SupplierRateLimiter } from './supplier-rate-limiter';
import {
  ERROR_BODY_MAX,
  SupplierAuthError,
  SupplierNetworkError,
  SupplierProtocolError,
  SupplierRateLimitError,
  SupplierServerError,
} from './supplier-errors';

/** Типовий тайм-аут запиту до постачальника; експорт прайсу й пошук — свій через `timeoutMs`. */
export const SUPPLIER_HTTP_TIMEOUT_MS = 20_000;

type QueryValue = string | number | boolean | null | undefined | Array<string | number>;

export interface SupplierHttpRequest {
  /** Назва постачальника для тексту помилки («AVD 429: …»). */
  provider: string;
  baseUrl: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  body?: unknown;
  /** Значення секретів, які треба вирізати з тексту помилки (ключ у тілі, пароль логіну). */
  secrets?: Array<string | null | undefined>;
  timeoutMs?: number;
  /** Область квоти (SupplierRateLimiter); без неї ліміт не враховується. */
  rateScope?: string;
  /** Статуси, які постачальник віддає замість 429 (Tehnomir — 503 «Exceeded the allowable limit»). */
  rateLimitStatuses?: number[];
  /** Повна адреса замість baseUrl + path (посилання на файл прайсу AVD). */
  absoluteUrl?: string;
  responseType?: 'json' | 'text';
}

export interface SupplierHttpResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

/** Коди помилок undici, за яких запит гарантовано НЕ дійшов до сервера. */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH']);

/**
 * Єдиний HTTP-клієнт до API постачальників (BR-SCON-005) — узагальнення
 * `nova-poshta.client.ts#call`: перевірка адреси (`SupplierUrlPolicy`), `redirect: 'manual'`
 * (перенаправлення відхиляється — інакше перевірку адреси обійшов би 302 на внутрішню),
 * тайм-аут через AbortController, типізовані помилки, текст без секретів, облік квоти.
 */
@Injectable()
export class SupplierHttpClient {
  constructor(
    private readonly urlPolicy: SupplierUrlPolicy,
    private readonly rateLimiter: SupplierRateLimiter,
  ) {}

  async request<T = unknown>(req: SupplierHttpRequest): Promise<SupplierHttpResponse<T>> {
    const url = req.absoluteUrl ?? buildUrl(req.baseUrl, req.path, req.query);
    const urlError = this.urlPolicy.check(url);
    if (urlError) {
      throw new SupplierProtocolError(
        req.provider,
        `${req.provider}: адресу API відхилено — ${urlError}`,
      );
    }
    if (req.rateScope) await this.rateLimiter.assertAvailable(req.rateScope, req.provider);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? SUPPLIER_HTTP_TIMEOUT_MS);
    const hasBody = req.body !== undefined && req.method !== 'GET';
    let response: Response;
    try {
      response = await fetch(url, {
        method: req.method,
        redirect: 'manual',
        headers: {
          Accept: 'application/json',
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
          ...(req.headers ?? {}),
        },
        body: hasBody ? JSON.stringify(req.body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      throw this.networkError(req, e, controller.signal.aborted);
    } finally {
      clearTimeout(timer);
    }

    await this.observeQuota(req, response.headers);

    if (response.status >= 300 && response.status < 400) {
      throw new SupplierProtocolError(
        req.provider,
        `${req.provider} ${response.status}: перенаправлення відхилено`,
        response.status,
      );
    }
    const text = await response.text().catch(() => '');
    const safeText = redactSecrets(text, req.secrets ?? []).slice(0, ERROR_BODY_MAX);

    if (response.status === 429 || req.rateLimitStatuses?.includes(response.status)) {
      const waitMs = retryAfterMs(response.headers) ?? DEFAULT_RATE_LIMIT_PAUSE_MS;
      if (req.rateScope) await this.rateLimiter.block(req.rateScope, waitMs);
      throw new SupplierRateLimitError(
        req.provider,
        `${req.provider} ${response.status}: ліміт запитів — ${safeText}`,
        waitMs,
        response.status,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new SupplierAuthError(
        req.provider,
        `${req.provider} ${response.status}: ${safeText}`,
        response.status,
      );
    }
    if (response.status >= 500) {
      throw new SupplierServerError(
        req.provider,
        `${req.provider} ${response.status}: ${safeText}`,
        response.status,
      );
    }
    if (!response.ok) {
      throw new SupplierProtocolError(
        req.provider,
        `${req.provider} ${response.status}: ${safeText}`,
        response.status,
      );
    }

    if (req.responseType === 'text') {
      return { status: response.status, headers: response.headers, data: text as T };
    }
    if (!text) return { status: response.status, headers: response.headers, data: {} as T };
    try {
      return { status: response.status, headers: response.headers, data: JSON.parse(text) as T };
    } catch {
      // 2xx з не-JSON: постачальник міг виконати дію — для оформлення це неоднозначно.
      throw new SupplierProtocolError(
        req.provider,
        `${req.provider} ${response.status}: відповідь не JSON — ${safeText}`,
        response.status,
        true,
      );
    }
  }

  private networkError(
    req: SupplierHttpRequest,
    e: unknown,
    timedOut: boolean,
  ): SupplierNetworkError {
    if (timedOut) {
      return new SupplierNetworkError(req.provider, `${req.provider}: тайм-аут запиту`, true);
    }
    const cause = (e as { cause?: { code?: string } })?.cause;
    const code = cause?.code ?? (e as { code?: string })?.code ?? '';
    const notSent = NOT_SENT_CODES.has(code);
    return new SupplierNetworkError(
      req.provider,
      `${req.provider}: немає зв'язку${code ? ` (${code})` : ''}`,
      !notSent,
    );
  }

  /** `x-ratelimit-remaining: 0` — квота вичерпана, наступні запити чекають скидання. */
  private async observeQuota(req: SupplierHttpRequest, headers: Headers): Promise<void> {
    if (!req.rateScope) return;
    const remaining = headers.get('x-ratelimit-remaining');
    if (remaining === null || Number(remaining) > 0) return;
    const reset = Number(headers.get('x-ratelimit-reset'));
    const ms = Number.isFinite(reset) && reset > 0 ? reset * 1000 : DEFAULT_RATE_LIMIT_PAUSE_MS;
    await this.rateLimiter.block(req.rateScope, ms);
  }
}

export function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, QueryValue>,
): string {
  const base = baseUrl.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const item of v) params.append(k, String(item));
    else params.append(k, String(v));
  }
  const qs = params.toString();
  return `${base}${p}${qs ? `?${qs}` : ''}`;
}

/** `Retry-After` (секунди чи HTTP-дата) → мс; інакше `x-ratelimit-reset` (секунди до скидання). */
export function retryAfterMs(headers: Headers, now = Date.now()): number | null {
  const ra = headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs >= 0) return Math.max(1000, secs * 1000);
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return Math.max(1000, at - now);
  }
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return reset * 1000;
  return null;
}
