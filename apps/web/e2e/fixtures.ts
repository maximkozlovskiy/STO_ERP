import { test as base, expect, Page } from '@playwright/test';

// ─── Shared auth helpers ──────────────────────────────────────────────────

export async function clearAuthState(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/login');
  await page.evaluate(() => {
    sessionStorage.clear();
    localStorage.clear();
  });
}

// ─── Shared date-filter helpers ───────────────────────────────────────────

export async function clearDateFilter(page: Page): Promise<void> {
  const dateInputs = page.locator('input[placeholder="Від"], input[placeholder="До"]');
  const count = await dateInputs.count();
  await Promise.all(
    Array.from({ length: count }, (_, i) =>
      dateInputs
        .nth(i)
        .fill('')
        .then(() => dateInputs.nth(i).press('Escape')),
    ),
  );
  await page.locator('h1').first().click({ force: true });
  await page
    .locator('.rdp-month')
    .waitFor({ state: 'hidden', timeout: 2_000 })
    .catch(() => {});
}

// ─── Shared helpers ────────────────────────────────────────────────────────

export async function loginViaAPI(page: Page) {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
  const result = await page.evaluate(
    async ({ apiBase, email, password }) => {
      const r = await fetch(`${apiBase}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      const json = await r.json();
      return { ok: r.ok, accessToken: json.accessToken as string };
    },
    {
      apiBase,
      email: process.env.E2E_EMAIL ?? 'admin@sto.local',
      password: process.env.E2E_PASSWORD ?? 'admin123',
    },
  );
  if (!result.ok || !result.accessToken) throw new Error('loginViaAPI failed');
  await page.evaluate(
    token => sessionStorage.setItem('sto_access_token', token),
    result.accessToken,
  );
}

// ─── Custom fixtures ────────────────────────────────────────────────────────

type AuthFixtures = {
  /** Сторінка з вже виставленим auth токеном (через storageState) */
  authPage: Page;
};

export const test = base.extend<AuthFixtures>({
  authPage: async ({ browser }, use) => {
    const context = await browser.newContext({
      storageState: 'e2e/.auth/admin.json',
      locale: 'uk-UA',
      timezoneId: 'Europe/Kyiv',
    });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

export { expect };
