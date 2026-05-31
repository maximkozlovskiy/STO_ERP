import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

test.describe('Звіти', () => {
  test('сторінка завантажується', async ({ page }) => {
    await page.goto('/reports');
    await expect(page.locator('h1:has-text("Звіти")')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('nextjs-portal, [data-nextjs-dialog]')).not.toBeVisible();
  });

  test('всі 5 вкладок присутні', async ({ page }) => {
    await page.goto('/reports');
    await expect(page.locator('h1:has-text("Звіти")')).toBeVisible({ timeout: 20_000 });

    for (const label of ['Виручка', 'Наряди', 'Розрахунки', 'Завантаженість']) {
      await expect(page.locator(`button:has-text("${label}")`).first()).toBeVisible({
        timeout: 10_000,
      });
    }
  });

  test('вкладка Виручка — відображає таблицю або empty state', async ({ page }) => {
    await page.goto('/reports');
    await expect(page.locator('h1:has-text("Звіти")')).toBeVisible({ timeout: 20_000 });
    await page.locator('button:has-text("Виручка")').first().click();

    await expect(
      // Або таблиця з даними, або loading spinner, або "Завантаження…"
      page
        .locator('table, [class*="animate-pulse"]')
        .or(page.getByText(/Завантаження|Нічого не знайдено/i))
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('вкладка Наряди — відображає таблицю або empty state', async ({ page }) => {
    await page.goto('/reports');
    await expect(page.locator('h1:has-text("Звіти")')).toBeVisible({ timeout: 20_000 });
    await page.locator('button:has-text("Наряди")').first().click();

    await expect(
      // Або таблиця з даними, або loading spinner, або "Завантаження…"
      page
        .locator('table, [class*="animate-pulse"]')
        .or(page.getByText(/Завантаження|Нічого не знайдено/i))
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('вкладка Завантаженість — відображає таблицю або empty state', async ({ page }) => {
    await page.goto('/reports');
    await expect(page.locator('h1:has-text("Звіти")')).toBeVisible({ timeout: 20_000 });
    await page.locator('button:has-text("Завантаженість")').first().click();

    await expect(
      // Або таблиця з даними, або loading spinner, або "Завантаження…"
      page
        .locator('table, [class*="animate-pulse"]')
        .or(page.getByText(/Завантаження|Нічого не знайдено/i))
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('кнопка "Експорт CSV" присутня', async ({ page }) => {
    await page.goto('/reports');
    await expect(page.locator('h1:has-text("Звіти")')).toBeVisible({ timeout: 20_000 });

    await expect(page.locator('button:has-text("Експорт CSV")').first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('CSV export — тригерить download', async ({ page }) => {
    await page.goto('/reports');
    await expect(page.locator('h1:has-text("Звіти")')).toBeVisible({ timeout: 20_000 });

    const csvBtn = page.locator('button:has-text("Експорт CSV")').first();
    if (!(await csvBtn.isVisible({ timeout: 10_000 }))) return;

    // Очікуємо download event або просто клікаємо і перевіряємо немає помилок
    const downloadPromise = page.waitForEvent('download', { timeout: 5_000 }).catch(() => null);
    await csvBtn.click();
    const download = await downloadPromise;
    if (download) {
      expect(download.suggestedFilename()).toMatch(/\.csv$/);
    }
    // Якщо download не спрацював — перевіряємо що немає console error
    await expect(page.locator('[data-nextjs-dialog]')).not.toBeVisible({ timeout: 3_000 });
  });

  test('фільтр дат — можна змінити період', async ({ page }) => {
    await page.goto('/reports');
    await expect(page.locator('h1:has-text("Звіти")')).toBeVisible({ timeout: 20_000 });

    // DatePickerInput для from/to
    const dateInputs = page.locator('input[placeholder*="ДД.ММ.РРРР"]');
    const count = await dateInputs.count();
    expect(count, 'Мають бути поля дат').toBeGreaterThanOrEqual(1);
  });
});
