/**
 * Єдине джерело адреси API для всіх E2E (спеки, хелпери, globalSetup, playwright.config).
 *
 * Порядок: `E2E_API_URL` → `NEXT_PUBLIC_API_URL` → `http://localhost:3000`.
 * `playwright.config.ts` передає `API_ORIGIN` у свій webServer як `NEXT_PUBLIC_API_URL`, тож
 * локальний E2E-сервер :3002 і запити спеків ідуть на той самий API. Прогін проти свіжого API
 * на іншому порту — лише змінними, без копій спеків:
 *   E2E_API_URL=http://localhost:3010 NEXT_PUBLIC_API_URL=http://localhost:3010 npx playwright test …
 *
 * УВАГА: усередині `page.evaluate(() => …)` ці константи НЕ видно — функція серіалізується й
 * виконується в браузері. Передавати аргументом: `page.evaluate(({ api }) => …, { api: API })`.
 */
export const API_ORIGIN = (
  process.env.E2E_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  'http://localhost:3000'
).replace(/\/+$/, '');

/** Базовий префікс версіонованих бізнес-роутів. */
export const API = `${API_ORIGIN}/api/v1`;

/**
 * Те саме для запитів із Node (globalSetup, APIRequestContext): `localhost` → `127.0.0.1`.
 * Bug #566: Node на Windows резолвить `localhost` спершу в `::1`, а API слухає лише IPv4
 * (`0.0.0.0`) → періодичне ECONNREFUSED ::1. Браузер (Chromium) dual-stack обробляє сам.
 */
export const API_ORIGIN_IPV4 = API_ORIGIN.replace('//localhost', '//127.0.0.1');
