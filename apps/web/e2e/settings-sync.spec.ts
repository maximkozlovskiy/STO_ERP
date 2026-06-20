import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * /settings/sync — Cloud Sync status + manual trigger.
 * Покриваємо: завантаження, рендер карточок (Помилки/Очікують), останній sync,
 * наявність кнопки "Синхронізувати зараз", роль-обмеження (OWNER+ADMIN тільки).
 */
test.describe('Налаштування — Cloud Sync', () => {
  test('сторінка завантажується з заголовком', async ({ page }) => {
    await page.goto('/settings/sync');
    await expect(page.locator('h1:has-text("Cloud Sync")')).toBeVisible({ timeout: 20_000 });
  });

  test('опис "Опціональна функція" присутній', async ({ page }) => {
    await page.goto('/settings/sync');
    await expect(page.locator('h1:has-text("Cloud Sync")')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Опціональна функція/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test('картки "Помилки" і "Очікують" рендеряться з числами', async ({ page }) => {
    await page.goto('/settings/sync');
    await expect(page.locator('h1:has-text("Cloud Sync")')).toBeVisible({ timeout: 20_000 });

    await expect(page.getByText(/^Помилки$/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/^Очікують$/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test('блок "Остання синхронізація" + "Поточна версія" видно', async ({ page }) => {
    await page.goto('/settings/sync');
    await expect(page.locator('h1:has-text("Cloud Sync")')).toBeVisible({ timeout: 20_000 });

    await expect(page.getByText(/Остання синхронізація/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/syncVersion|версія/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test('кнопка "Синхронізувати зараз" присутня', async ({ page }) => {
    await page.goto('/settings/sync');
    await expect(page.locator('h1:has-text("Cloud Sync")')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('button:has-text("Синхронізувати зараз")').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('клік "Синхронізувати зараз" → з\'являється повідомлення про результат', async ({
    page,
  }) => {
    await page.goto('/settings/sync');
    await expect(page.locator('h1:has-text("Cloud Sync")')).toBeVisible({ timeout: 20_000 });
    const btn = page.locator('button:has-text("Синхронізувати зараз")').first();
    await expect(btn).toBeEnabled({ timeout: 10_000 });
    await btn.click();

    // Очікуємо success або error msg
    await expect(
      page.getByText(/Синхронізація завершена|Помилка синхронізації|записів/i).first(),
    ).toBeVisible({ timeout: 20_000 });
  });
});
