import { test as base, expect, Page } from '@playwright/test';
import { API_ORIGIN } from './api-url';

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

/**
 * Знімає обидві межі фільтра дат списку (кнопка «×» «Очистити дату» в кожному полі).
 *
 * До 2026-10-13 помічник шукав поля за placeholder «Від» / «До», яких у застосунку немає, тобто
 * НІЧОГО не робив: специ, що його кликали, насправді працювали під типовим фільтром «сьогодні».
 * Тепер фільтр справді знімається: після виклику жодне поле дати на сторінці не заповнене.
 */
export async function clearDateFilter(page: Page): Promise<void> {
  // Фільтр змонтований: поля дат видно (типові значення стоять одразу з першого рендера).
  await expect(page.getByPlaceholder('ДД.ММ.РРРР').first()).toBeVisible();
  const clear = page.getByRole('button', { name: 'Очистити дату' });
  // Кнопка є лише біля заповненої межі й зникає після натискання — тиснемо першу, доки є.
  // Межа запасу: у списку дві межі; чотири — на випадок двох фільтрів на сторінці.
  for (let i = 0; i < 4; i++) {
    if ((await clear.count()) === 0) break;
    await clear.first().click();
  }
  await expect(clear).toHaveCount(0);
  // Очищення календар не відкриває (фокус повертається в поле без попапа).
  await expect(page.locator('.rdp-root')).toHaveCount(0);
}

// ─── Shared helpers ────────────────────────────────────────────────────────

export async function loginViaAPI(page: Page) {
  const apiBase = API_ORIGIN;
  const result = await page.evaluate(
    async ({ apiBase, email, password }) => {
      const r = await fetch(`${apiBase}/api/v1/auth/login`, {
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
