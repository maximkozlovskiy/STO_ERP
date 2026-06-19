import { chromium } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Глобальний setup: логінимся раз і зберігаємо storage state у e2e/.auth/admin.json.
 * Тести з `test.use({ storageState: 'e2e/.auth/admin.json' })` отримують готову сесію.
 *
 * Запускається один раз перед усіма тестами (globalSetup в playwright.config.ts).
 */
async function globalSetup() {
  const baseURL = 'http://localhost:3001';
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

  // Step 1: get JWT через прямий API виклик (швидше за UI логін)
  const res = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.E2E_EMAIL ?? 'admin@sto.local',
      password: process.env.E2E_PASSWORD ?? 'admin123',
    }),
  });

  if (!res.ok) {
    throw new Error(`E2E auth setup failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { accessToken: string; employee?: unknown };

  // Step 2: запустити browser, проставити sessionStorage з access token,
  // зробити будь-який request щоб refresh-cookie зберігся.
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();

  // Перехопити refresh cookie через відвідування /login (API ставить httpOnly cookie).
  // Краще: повторно зробити login через browser-side fetch — щоб cookie був у browser context.
  await page.goto(`${baseURL}/login/`);
  const loginResult = await page.evaluate(
    async ({ email, password, apiBase }) => {
      const r = await fetch(`${apiBase}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      const json = await r.json();
      return { ok: r.ok, accessToken: json.accessToken };
    },
    {
      email: process.env.E2E_EMAIL ?? 'admin@sto.local',
      password: process.env.E2E_PASSWORD ?? 'admin123',
      apiBase,
    },
  );

  if (!loginResult.ok || !loginResult.accessToken) {
    throw new Error('E2E browser login failed');
  }

  // Set access token у sessionStorage (TOKEN_KEY = 'sto_access_token')
  await page.evaluate(token => {
    sessionStorage.setItem('sto_access_token', token);
  }, loginResult.accessToken);

  // Save state — включає cookies (sto_refresh) і sessionStorage (через storage state)
  const authDir = path.join(__dirname, '.auth');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
  const statePath = path.join(authDir, 'admin.json');

  await context.storageState({ path: statePath });
  // sessionStorage НЕ зберігається через storageState (тільки cookies + localStorage).
  // Дописуємо access token у localStorage також — fallback для тестів якщо app
  // умовно читає з localStorage. Для повної ізоляції — в тестах окремо setSessionStorage.
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  // Add sessionStorage record manually so Playwright restores it on context creation.
  // Playwright 1.40+ підтримує sessionStorage у storage state.
  if (!Array.isArray(state.origins)) state.origins = [];
  let origin = state.origins.find((o: { origin: string }) => o.origin === baseURL);
  if (!origin) {
    origin = { origin: baseURL, localStorage: [] };
    state.origins.push(origin);
  }
  origin.localStorage = origin.localStorage || [];
  // Hide TanStack Query Devtools FAB during E2E — it sits bottom-left and
  // intercepts pointer events for hover-only icon buttons in the last column
  // of tables when Playwright scrolls a row into view at the bottom of the
  // viewport. QueryProvider checks this localStorage key.
  const hasDevtoolsFlag = origin.localStorage.some(
    (e: { name: string }) => e.name === 'sto_e2e_disable_devtools',
  );
  if (!hasDevtoolsFlag) {
    origin.localStorage.push({ name: 'sto_e2e_disable_devtools', value: '1' });
  }
  // Save accessToken in localStorage too as fallback (most pages read sessionStorage via TOKEN_KEY)
  // Real apps use sessionStorage — Playwright stores it as `sessionStorage` since 1.40.
  origin.sessionStorage = [{ name: 'sto_access_token', value: loginResult.accessToken }];
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  await browser.close();
  console.log(`E2E auth state saved to ${statePath}`);
}

export default globalSetup;
