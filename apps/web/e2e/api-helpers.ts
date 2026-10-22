import { randomUUID } from 'crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { API, API_ORIGIN_IPV4 } from './api-url';

/**
 * Спільні помічники E2E для запитів до API від імені користувача: токен зі storage сторінки і
 * запит із повтором на 429.
 *
 * Повтор потрібен, бо ліміт API — 200 запитів/хв на IP, а вид календаря «Місяць» робить
 * 32 запити за завантаження: поряд з іншими спеками ліміт вичерпується, і без повтору
 * прибирання в `afterAll` мовчки не видаляло запис — наступний прогін падав на «Підйомник
 * вже зайнятий».
 */

export { API };

export interface ApiResult<T> {
  status: number;
  body: T;
}

/** `API` для запитів із Node (див. `API_ORIGIN_IPV4`). */
const API_IPV4 = `${API_ORIGIN_IPV4}/api/v1`;
const RETRY_429_ATTEMPTS = 12;
const RETRY_429_DELAY_MS = 5_000;

/** Access-токен користувача сторінки (sessionStorage, у E2E-збірці — localStorage). */
export async function getToken(page: Page): Promise<string> {
  const token = await page.evaluate(
    () =>
      sessionStorage.getItem('sto_access_token') ?? localStorage.getItem('sto_e2e_access_token'),
  );
  expect(token, 'access token має бути у storage').toBeTruthy();
  return token as string;
}

async function retryOn429<T>(
  call: () => Promise<ApiResult<T>>,
  wait: (ms: number) => Promise<void>,
): Promise<ApiResult<T>> {
  for (let attempt = 0; ; attempt++) {
    const res = await call();
    if (res.status !== 429 || attempt >= RETRY_429_ATTEMPTS) return res;
    await wait(RETRY_429_DELAY_MS);
  }
}

/**
 * Ключ ідемпотентності POST-запиту: каса, оплати й сторно без нього — 400 (рішення власника
 * 2026-10-22), решта маршрутів заголовок ігнорує. Один ключ на виклик — повтор після 429 іде з тим
 * самим ключем, як справжній повтор клієнта.
 */
function postKey(method: string): string | undefined {
  return method.toUpperCase() === 'POST' ? randomUUID() : undefined;
}

/**
 * Запит до API з браузера сторінки (fetch у контексті сторінки) з повтором на 429.
 * Тіло відповіді — JSON, текст, якщо не JSON, або null для порожньої.
 */
export async function apiCall<T = unknown>(
  page: Page,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const idempotencyKey = postKey(method);
  return retryOn429(
    () =>
      page.evaluate(
        async ({ token, API, method, path, body, idempotencyKey }) => {
          const r = await fetch(`${API}${path}`, {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
              ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          });
          const text = await r.text();
          let parsed: unknown = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          return { status: r.status, body: parsed as never };
        },
        { token, API, method, path, body, idempotencyKey },
      ),
    ms => page.waitForTimeout(ms),
  );
}

/**
 * Те саме з Node через `APIRequestContext` (фікстура `request`) — без сторінки й браузера,
 * напр. для прибирання в `afterAll`. Адреса — IPv4 (Bug #566: Node на Windows резолвить
 * `localhost` спершу в `::1`).
 */
export async function apiRequest<T = unknown>(
  request: APIRequestContext,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const idempotencyKey = postKey(method);
  return retryOn429(
    async () => {
      const r = await request.fetch(`${API_IPV4}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        ...(body !== undefined ? { data: body } : {}),
      });
      const text = await r.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: r.status(), body: parsed as T };
    },
    ms => new Promise(resolve => setTimeout(resolve, ms)),
  );
}
