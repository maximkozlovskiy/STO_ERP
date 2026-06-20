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
  // Bug #566: Force IPv4 (127.0.0.1) to avoid Node ::1 (IPv6) resolution on Windows
  // when API binds only to 0.0.0.0 (IPv4). Otherwise globalSetup intermittently fails
  // with ECONNREFUSED ::1:3000 during fetch().
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:3000';

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
      return { ok: r.ok, accessToken: json.accessToken, employee: json.employee };
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
  // Bug #567: also write employee cache to localStorage (EMPLOYEE_CACHE_KEY = 'sto_employee_cache').
  // Without it AuthProvider optimistic init falls into isLoading=true → refreshToken() →
  // 401 (no refresh cookie captured cross-origin) → LOGOUT → redirect to /login.
  // With cached employee + valid token → init skips refresh, TopShell renders immediately.
  await page.evaluate(
    ({ token, employee }) => {
      sessionStorage.setItem('sto_access_token', token);
      if (employee) {
        localStorage.setItem('sto_employee_cache', JSON.stringify(employee));
      }
    },
    { token: loginResult.accessToken, employee: loginResult.employee },
  );

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
  // Bug #567: skip refresh-on-mount during E2E — the refresh cookie cannot be captured
  // cross-origin by Playwright storageState. AuthProvider checks this flag + cached
  // employee and trusts the stored token instead of triggering 401-prone refresh.
  const hasSkipRefreshFlag = origin.localStorage.some(
    (e: { name: string }) => e.name === 'sto_e2e_skip_refresh',
  );
  if (!hasSkipRefreshFlag) {
    origin.localStorage.push({ name: 'sto_e2e_skip_refresh', value: '1' });
  }
  // Bug #567: persist employee cache so optimistic init in AuthProvider sees
  // valid (token + cached employee) tuple → renders TopShell immediately.
  if (loginResult.employee) {
    const hasEmployeeCache = origin.localStorage.some(
      (e: { name: string }) => e.name === 'sto_employee_cache',
    );
    if (!hasEmployeeCache) {
      origin.localStorage.push({
        name: 'sto_employee_cache',
        value: JSON.stringify(loginResult.employee),
      });
    }
  }
  // Bug #567: Playwright storageState restores localStorage but NOT sessionStorage
  // (known limitation, not honored despite admin.json having sessionStorage block).
  // Mirror the access token under sto_e2e_access_token in localStorage — AuthProvider's
  // reducer init copies it into sessionStorage on first render when the E2E flag is on.
  const hasMirrorToken = origin.localStorage.some(
    (e: { name: string }) => e.name === 'sto_e2e_access_token',
  );
  if (!hasMirrorToken) {
    origin.localStorage.push({
      name: 'sto_e2e_access_token',
      value: loginResult.accessToken,
    });
  } else {
    // Refresh existing value
    origin.localStorage = origin.localStorage.map((e: { name: string; value: string }) =>
      e.name === 'sto_e2e_access_token' ? { ...e, value: loginResult.accessToken } : e,
    );
  }
  // Save accessToken in sessionStorage too — kept for Playwright versions that DO restore it.
  origin.sessionStorage = [{ name: 'sto_access_token', value: loginResult.accessToken }];
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  await browser.close();
  console.log(`E2E auth state saved to ${statePath}`);
}

export default globalSetup;
