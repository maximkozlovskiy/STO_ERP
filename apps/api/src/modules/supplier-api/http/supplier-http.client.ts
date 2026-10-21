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
/** Типова межа тіла відповіді; файл прайсу — свою через `maxBodyBytes`. */
export const SUPPLIER_HTTP_MAX_BODY_BYTES = 20 * 1024 * 1024;
/** Найдовша пауза за підказкою постачальника (Retry-After / x-ratelimit-reset). */
export const MAX_RATE_LIMIT_PAUSE_MS = 3_600_000;

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
  /**
   * Статус із `rateLimitStatuses` — ліміт, лише якщо тіло відповідає шаблону (Tehnomir 503 буває
   * і справжньою серверною помилкою — тоді вона неоднозначна, а не «ліміт» без витрати спроби).
   */
  rateLimitBodyPattern?: RegExp;
  /** Межа тіла відповіді, байтів (типово SUPPLIER_HTTP_MAX_BODY_BYTES). */
  maxBodyBytes?: number;
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
    const urlError = await this.urlPolicy.checkResolved(url);
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
    let text = '';
    // Тайм-аут діє й на читання тіла: заголовки прийшли, а тіло «висить» — теж тайм-аут.
    try {
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
      }

      await this.observeQuota(req, response.headers);

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new SupplierProtocolError(
          req.provider,
          `${req.provider} ${response.status}: перенаправлення відхилено`,
          response.status,
        );
      }
      try {
        text = await readBody(response, req.maxBodyBytes ?? SUPPLIER_HTTP_MAX_BODY_BYTES);
      } catch (e) {
        // Помилкова відповідь класифікується за статусом і без тіла. Успішна без тіла — ні:
        // постачальник дію виконав, а результату ми не знаємо (оформлення → звірка, BR-SCON-011).
        if (!response.ok) text = '';
        else if (e instanceof BodyTooLargeError) {
          throw new SupplierProtocolError(
            req.provider,
            `${req.provider} ${response.status}: відповідь завелика`,
            response.status,
            true,
          );
        } else {
          const what = controller.signal.aborted ? 'тайм-аут читання відповіді' : 'обрив відповіді';
          throw new SupplierNetworkError(
            req.provider,
            `${req.provider} ${response.status}: ${what}`,
            true,
          );
        }
      }
    } finally {
      clearTimeout(timer);
    }
    const safeText = redactSecrets(text, req.secrets ?? []).slice(0, ERROR_BODY_MAX);

    const limitByStatus =
      !!req.rateLimitStatuses?.includes(response.status) &&
      (!req.rateLimitBodyPattern || req.rateLimitBodyPattern.test(text));
    if (response.status === 429 || limitByStatus) {
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
    const ms = resetToMs(headers.get('x-ratelimit-reset')) ?? DEFAULT_RATE_LIMIT_PAUSE_MS;
    await this.rateLimiter.block(req.rateScope, ms);
  }
}

class BodyTooLargeError extends Error {}

/** Тіло відповіді з межею розміру (декодування — як у `response.text()`: UTF-8 без BOM). */
async function readBody(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new BodyTooLargeError();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  // Потокове декодування: шматки не накопичуються й не склеюються ще однією копією (прайс AVD —
  // сотні МБ); `stream: true` тримає розірваний між шматками символ UTF-8 до наступного.
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

const clampPause = (ms: number) => Math.min(MAX_RATE_LIMIT_PAUSE_MS, Math.max(1000, ms));

/**
 * Число з заголовка скидання квоти → мс до скидання: секунди «через скільки» або мітка часу
 * epoch (секунди чи мс) — деякі постачальники віддають саме її. Не довше MAX_RATE_LIMIT_PAUSE_MS.
 */
function resetToMs(raw: string | null, now = Date.now()): number | null {
  if (raw === null || raw.trim() === '') return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v > 1e12) return clampPause(v - now); // epoch, мс
  if (v > 1e9) return clampPause(v * 1000 - now); // epoch, секунди
  return clampPause(v * 1000);
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

/**
 * `Retry-After` (секунди чи HTTP-дата) → мс; інакше `x-ratelimit-reset` (секунди до скидання чи
 * epoch). Пауза — від 1 с до MAX_RATE_LIMIT_PAUSE_MS: кривий заголовок не заморозить чергу на дні.
 */
export function retryAfterMs(headers: Headers, now = Date.now()): number | null {
  const ra = headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (ra.trim() !== '' && Number.isFinite(secs) && secs >= 0) {
      return secs > 1e9 ? clampPause(secs * 1000 - now) : clampPause(secs * 1000);
    }
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return clampPause(at - now);
  }
  return resetToMs(headers.get('x-ratelimit-reset'), now);
}
