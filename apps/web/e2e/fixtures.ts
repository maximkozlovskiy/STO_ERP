import { test as base, expect, Browser, BrowserContext, Page } from '@playwright/test';
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

/**
 * Логін через РЕАЛЬНУ форму /login у свіжому browser-контексті (для рольових сценаріїв:
 * приймальня / механік / комірник відкривають власну сесію поруч з адмінською).
 *
 * Чому не просто «заповнити форму й чекати редірект»: кожна навігація в контексті перемонтовує
 * AuthProvider, і той на mount робить фоновий POST /auth/refresh (щоб підтвердити сесію). Але
 * refresh-cookie `sto_refresh` виставлений на origin API, `SameSite=Strict`, `path=/api/v1/auth`;
 * у кількапотоковому локальному прогоні паралельні refresh-и з одного IP вичерпують ліміт
 * (30/хв) → 429. До Bug #966 застосунок трактував 429 як мертву сесію й кидав щойно
 * залогіненого користувача на /login — чотири рольові E2E падали саме так.
 *
 * Тому дзеркалимо setup-auth.ts: після форм-логіну ставимо ті самі E2E-прапорці, що й
 * globalSetup для адмінської сесії, — `sto_e2e_skip_refresh` (AuthProvider довіряє кешованому
 * employee + токену й НЕ робить refresh-on-mount) плюс дзеркало токена в localStorage для
 * гідратації sessionStorage після перезавантаження/нового таба. Так ad-hoc контекст поводиться
 * рівно як справжній застосунок для користувача, який щойно увійшов. Прапорці діють лише у
 * E2E-збірці (NEXT_PUBLIC_E2E=1) — у проді hatch tree-shake-иться.
 */
export async function loginViaForm(
  browser: Browser,
  login: { email: string; password: string },
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(login.email);
  await page.getByLabel('Пароль').fill(login.password);
  await page.getByRole('button', { name: 'Увійти' }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
  // login() у AuthProvider уже записав sessionStorage[sto_access_token] і localStorage
  // employee-cache. Додаємо E2E-прапорці, щоб наступні навігації не робили refresh-on-mount.
  await page.evaluate(() => {
    const token = sessionStorage.getItem('sto_access_token');
    localStorage.setItem('sto_e2e_skip_refresh', '1');
    localStorage.setItem('sto_e2e_disable_devtools', '1');
    if (token) localStorage.setItem('sto_e2e_access_token', token);
  });
  return { ctx, page };
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
