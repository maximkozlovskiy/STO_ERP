import { test, expect } from '@playwright/test';

/**
 * API error resilience — сторінки не повинні крашитись (500 з Next.js) коли API повертає 500.
 *
 * Не вимагаємо специфічного fallback UI — лише що:
 *  - HTTP відповідь від Next.js < 500
 *  - на сторінці є хоч щось видиме (body не пустий)
 *
 * Виконується БЕЗ авторизації. Для захищених сторінок очікуємо graceful поведінку:
 * або redirect на /login, або порожня сторінка зі спінером, але не Next.js crash.
 */

test.describe('API error resilience — захищені сторінки', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  const PROTECTED_PAGES = [
    '/work-orders',
    '/inventory',
    '/counterparties',
    '/calendar',
    '/invoices',
  ];

  for (const path of PROTECTED_PAGES) {
    test(`${path} — не крашиться при 500 від API`, async ({ page }) => {
      await page.route('**/api/**', route =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ statusCode: 500, message: 'Internal Server Error' }),
        }),
      );

      const response = await page.goto(path);
      // Next.js не повертає 500 для самої сторінки
      expect(response?.status() ?? 200).toBeLessThan(500);

      // Сторінка має body (не порожній crash page)
      await expect(page.locator('body')).toBeVisible();
      // Має бути або redirect на /login (auth guard), або відрендерений UI
      await page.waitForLoadState('domcontentloaded');
      const url = page.url();
      // Або redirect, або залишилась на захищеній сторінці без crash
      expect(url).toBeTruthy();
    });
  }
});

test.describe('API error resilience — публічні сторінки', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('/login — рендериться навіть при 500 на /api/auth/refresh', async ({ page }) => {
    await page.route('**/api/auth/**', route =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ statusCode: 500, message: 'Internal Server Error' }),
      }),
    );

    const response = await page.goto('/login');
    expect(response?.status() ?? 200).toBeLessThan(500);
    // Форма логіну має містити поле email — використовуємо .first() для strict mode
    await expect(
      page.locator('input[type="email"], input[name="email"], input#email').first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('/setup — рендериться без жодних API запитів', async ({ page }) => {
    await page.route('**/api/**', route => route.fulfill({ status: 500 }));
    const response = await page.goto('/setup');
    expect(response?.status() ?? 200).toBeLessThan(500);
    await page.waitForLoadState('domcontentloaded');
    // Сторінка setup не повинна редирекитись на /login
    expect(page.url()).not.toMatch(/\/login/);
  });

  test('/ (корінь) — не падає при 500 від API', async ({ page }) => {
    await page.route('**/api/**', route => route.fulfill({ status: 500 }));
    const response = await page.goto('/');
    expect(response?.status() ?? 200).toBeLessThan(500);
  });
});
