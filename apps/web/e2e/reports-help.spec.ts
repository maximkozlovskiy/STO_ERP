import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

/**
 * Звіти — пояснення «?» і чесні вартості (рішення власника 2026-10-29), через браузер, лише
 * читання (даних не створює й не прибирає):
 *  1. «Завантаженість»: «?» відкриває пояснення робочого часу філії (BR-RPT-033), Escape закриває
 *     лише його й повертає фокус на кнопку; години в таблиці — «N год з M»;
 *  2. P&L: «?» пояснює рядки й формулу чистого прибутку (BR-RPT-030);
 *  3. «Звіт по складу»: дві вартості — «Собівартість» і «За цінами продажу» — у підсумку й колонках
 *     (BR-RPT-034).
 */
test.describe('Звіти — «?» і дві вартості складу', () => {
  test('«Завантаженість»: «?» з робочим часом філії, Escape закриває лише його', async ({
    page,
  }) => {
    await page.goto('/reports?tab=load');
    const button = page.getByRole('button', { name: 'Як рахується «Завантаженість»' });
    await expect(button).toBeVisible({ timeout: 30_000 });
    await button.click();
    const dialog = page.getByRole('dialog', { name: 'Як рахується «Завантаженість»' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Робочий час');
    await expect(dialog).toContainText('09:00–18:00, пн–пт');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(button).toBeFocused();
    await expect(page).toHaveURL(/tab=load/);
    const row = page.getByTestId('report-load-row').first();
    if (await row.count()) await expect(row).toContainText(/год з/);
  });

  test('P&L: «?» пояснює рядки й чистий прибуток', async ({ page }) => {
    await page.goto('/reports?tab=pnl');
    const button = page.getByRole('button', { name: 'Як рахується P&L' });
    await expect(button).toBeVisible({ timeout: 30_000 });
    await button.click();
    const dialog = page.getByRole('dialog', { name: 'Як рахується P&L' });
    await expect(dialog).toContainText('Метод нарахування');
    await expect(dialog).toContainText('Чистий прибуток');
    // Клік поза вікном закриває його.
    await page.getByRole('heading', { name: 'Звіти' }).click();
    await expect(dialog).toBeHidden();
  });

  test('«Звіт по складу»: собівартість і ціни продажу — у підсумку й колонках', async ({
    page,
  }) => {
    await page.goto('/reports?tab=stock');
    await expect(page.getByText('Собівартість залишків')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Залишки за цінами продажу')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Собівартість' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'За цінами продажу' })).toBeVisible();
    const first = page.getByTestId('report-stock-row').first();
    if (await first.count()) {
      await expect(first.getByTestId('report-stock-cost')).toContainText('₴');
      await expect(first.getByTestId('report-stock-sale')).toContainText('₴');
    }
  });
});
