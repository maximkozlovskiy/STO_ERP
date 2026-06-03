import { test, expect } from '@playwright/test';

// ─── Login flow ──────────────────────────────────────────────────────────────

test.describe('Auth — Login flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
  });

  test('login сторінка відображає форму', async ({ page }) => {
    await expect(page.locator('input[type="email"], input[name="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toBeVisible();
  });

  test('невірний пароль — показує помилку', async ({ page }) => {
    await page.locator('input[type="email"], input[name="email"]').fill('admin@sto.local');
    await page.locator('input[type="password"]').fill('wrongpassword');
    await page.locator('button[type="submit"]').click();

    // Має з'явитись повідомлення про помилку
    await expect(
      page.locator('[role="alert"], .text-destructive, [data-error]').first(),
    ).toBeVisible({ timeout: 10_000 });
    // Залишаємось на /login
    await expect(page).toHaveURL(/\/login/);
  });

  test('валідний логін → redirect на /dashboard або /work-orders', async ({ page }) => {
    await page.locator('input[type="email"], input[name="email"]').fill('admin@sto.local');
    await page.locator('input[type="password"]').fill('admin123');
    await page.locator('button[type="submit"]').click();

    // Після успішного логіну — перехід на захищену сторінку
    // Bug #343: /dashboard cold compile ~15-20s, needs more headroom
    await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
    const url = page.url();
    expect(url).toMatch(/\/(dashboard|work-orders)/);
  });

  test('порожні поля — кнопка disabled або показує валідацію', async ({ page }) => {
    await page.locator('button[type="submit"]').click();
    // Або кнопка залишається disabled, або форма показує required error
    const isDisabled =
      (await page.locator('button[type="submit"]').getAttribute('disabled')) !== null;
    const hasValidation = (await page.locator(':invalid, [aria-invalid="true"]').count()) > 0;
    expect(isDisabled || hasValidation).toBe(true);
  });
});

// ─── Auth Guard ──────────────────────────────────────────────────────────────

test.describe('Auth — Guard захищених роутів', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // Bug #342: storageState { cookies:[], origins:[] } не завжди скидає httpOnly cookies у shared worker context.
  // Явно очищуємо cookies + web storage щоб гарантувати fresh unauthenticated state.
  const clearAuthState = async (page: import('@playwright/test').Page) => {
    await page.context().clearCookies();
    await page.goto('/login');
    await page.evaluate(() => {
      sessionStorage.clear();
      localStorage.clear();
    });
  };

  const PROTECTED = [
    '/work-orders',
    '/calendar',
    '/crm',
    '/inventory',
    '/catalog',
    '/employees',
    '/invoices',
    '/settings',
    '/dashboard',
  ];

  for (const route of PROTECTED) {
    test(`${route} без auth → /login`, async ({ page }) => {
      await clearAuthState(page);
      await page.goto(route);
      await expect(page).toHaveURL(/\/(login|setup)/, { timeout: 20_000 });
    });
  }
});

// ─── Logout ──────────────────────────────────────────────────────────────────

test.describe('Auth — Logout', () => {
  test.use({ storageState: 'e2e/.auth/admin.json' });

  test('logout → redirect на /login', async ({ page }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('domcontentloaded');

    // Шукаємо logout кнопку (може бути в меню або TopShell)
    const logoutBtn = page
      .locator('[data-testid="logout"], button:has-text("Вийти"), button:has-text("Logout")')
      .first();
    if (await logoutBtn.isVisible()) {
      await logoutBtn.click();
      await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
    } else {
      // Якщо кнопка прихована в меню — відкриваємо
      const menuToggle = page
        .locator('[data-testid="user-menu"], [aria-label*="меню"], [aria-label*="menu"]')
        .first();
      if (await menuToggle.isVisible()) {
        await menuToggle.click();
        await logoutBtn.click();
        await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
      }
    }
  });
});
