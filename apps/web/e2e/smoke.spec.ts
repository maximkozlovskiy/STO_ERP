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

test.describe('Smoke — статичні ресурси (не повинні давати 404)', () => {
  test('favicon.ico повертає 200', async ({ request }) => {
    const res = await request.get('/favicon.ico');
    expect(res.status()).toBe(200);
  });

  test('icon-192.png повертає 200', async ({ request }) => {
    const res = await request.get('/icons/icon-192.png');
    expect(res.status()).toBe(200);
  });

  test('icon-512.png повертає 200', async ({ request }) => {
    const res = await request.get('/icons/icon-512.png');
    expect(res.status()).toBe(200);
  });
});

test.describe('Smoke — auth guard', () => {
  // Окремий describe з fresh context — гарантує що жодних кросс-test cookies немає
  test.use({ storageState: { cookies: [], origins: [] } });

  test('захищена /work-orders без auth — врешті redirect на /login', async ({ page }) => {
    // Bug #342: storageState не скидає httpOnly cookies у shared worker context
    // Явно очищуємо cookies + web storage
    await page.context().clearCookies();
    await page.goto('/login');
    await page.evaluate(() => {
      sessionStorage.clear();
      localStorage.clear();
    });
    await page.goto('/work-orders');
    await expect(page).toHaveURL(/\/(login|setup)/, { timeout: 20_000 });
  });
});

// Bug #135: security headers повинні бути на API (через @fastify/helmet).
// E2E перевіряє це проти живого API (не unit) бо helmet — Fastify plugin
// рівня bootstrap, а тестовий NestJS context використовує app.init() без bootstrap().
test.describe('Smoke — API security headers (Bug #135)', () => {
  const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

  test('GET /api/health повертає X-Content-Type-Options і X-Frame-Options', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/health`);
    expect(res.status()).toBe(200);
    const headers = res.headers();
    // Захист від MIME-sniffing
    expect(headers['x-content-type-options']).toBe('nosniff');
    // Захист від clickjacking
    expect(headers['x-frame-options']).toMatch(/^(DENY|SAMEORIGIN)$/i);
    // HSTS — критично для prod, але helmet встановлює і для dev
    expect(headers['strict-transport-security']).toBeTruthy();
    // CORP — потрібен 'cross-origin' щоб веб з порту 3001 міг споживати API на 3000
    expect(headers['cross-origin-resource-policy']).toBe('cross-origin');
  });
});
