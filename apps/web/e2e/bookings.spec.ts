import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

// ─────────────────────────────────────────────────────────────────────────────
// /bookings — адмін-сторінка перегляду заявок з онлайн-запису.
// Доступ: OWNER, ADMIN, RECEPTIONIST. Показує список запитів зі статусами
// PENDING / CONFIRMED / CANCELLED, дозволяє підтвердити (PATCH /booking/:id/confirm)
// або скасувати (DELETE /booking/:id). Empty-state: "Заявок на запис немає".
// ─────────────────────────────────────────────────────────────────────────────

test.describe('/bookings — список заявок', () => {
  test('сторінка завантажується без 500', async ({ page }) => {
    await page.goto('/bookings');
    await expect(page).toHaveURL(/\/bookings/, { timeout: 15_000 });
    // No Next.js error overlay
    await expect(page.locator('nextjs-portal, [data-nextjs-dialog]')).not.toBeVisible();
  });

  test('h1 "Онлайн-запис" присутній', async ({ page }) => {
    await page.goto('/bookings');
    await expect(page.locator('h1:has-text("Онлайн-запис")')).toBeVisible({ timeout: 15_000 });
  });

  test('кнопка "Оновити" присутня', async ({ page }) => {
    await page.goto('/bookings');
    await expect(page.locator('button:has-text("Оновити")').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('відображається або список заявок, або empty-state', async ({ page }) => {
    await page.goto('/bookings');
    await expect(
      page.locator('text=Заявок на запис немає').or(page.locator('div.divide-y > div').first()),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('кнопка "Оновити" не падає (refetch)', async ({ page }) => {
    await page.goto('/bookings');
    const refreshBtn = page.locator('button:has-text("Оновити")').first();
    await expect(refreshBtn).toBeVisible({ timeout: 15_000 });
    await refreshBtn.click();
    // Після refetch або відображається список або empty-state — інваріант сторінки
    await expect(
      page.locator('text=Заявок на запис немає').or(page.locator('div.divide-y > div').first()),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('GET /api/booking повертає 200 (контракт)', async ({ page }) => {
    await page.goto('/bookings');
    await page.waitForTimeout(500);
    const token = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));
    const result = await page.evaluate(
      async ({ token }) => {
        const r = await fetch('http://localhost:3000/api/booking', {
          headers: { Authorization: `Bearer ${token}` },
        });
        return { status: r.status, body: await r.text() };
      },
      { token },
    );
    expect(result.status).toBe(200);
    // Контракт: response має items[] + total
    const parsed = JSON.parse(result.body);
    expect(parsed).toHaveProperty('items');
    expect(Array.isArray(parsed.items)).toBe(true);
  });
});
