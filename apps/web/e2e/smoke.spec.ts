import { test, expect } from '@playwright/test';

test.describe('Smoke — публічні сторінки', () => {
  test('кореневий URL відповідає 200', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBeLessThan(400);
  });

  test('/login рендериться без помилок', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveURL(/\/login/);
  });

  test('/setup доступний без авторизації', async ({ page }) => {
    await page.goto('/setup');
    await expect(page).not.toHaveURL(/\/login/);
  });
});

test.describe('Smoke — auth guard', () => {
  // Окремий describe з fresh context — гарантує що жодних кросс-test cookies немає
  test.use({ storageState: { cookies: [], origins: [] } });

  test('захищена /work-orders без auth — врешті redirect на /login', async ({ page }) => {
    await page.goto('/work-orders');
    await expect(page).toHaveURL(/\/(login|setup)/, { timeout: 15_000 });
  });
});
